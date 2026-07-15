#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 4: Character Generation ==="
echo "Task ID: $TASK_ID"
echo "AI Account ID: $AI_ACCOUNT_ID"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/generate-characters.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

if [ -z "$AI_API_KEY" ]; then
    echo "Error: AI_API_KEY not set"
    exit 1
fi

echo "Downloading face selection result..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/face_selection_result.json" "./face_selection_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL"

RESULT=$(cat ./face_selection_result.json)
ROLE_COUNT=$(echo "$RESULT" | jq -r '.characters | length')

echo "Found $ROLE_COUNT characters"

mkdir -p ./characters
mkdir -p ./locks

ACCOUNT_COUNT=1
if [ -n "$AI_ACCOUNTS" ]; then
    ACCOUNT_COUNT=$(echo "$AI_ACCOUNTS" | jq -r '. | length')
fi

MAX_CONCURRENT=${MAX_CONCURRENT:-2}
EFFECTIVE_CONCURRENCY=$(( ACCOUNT_COUNT < MAX_CONCURRENT ? ACCOUNT_COUNT : MAX_CONCURRENT ))

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Max concurrent (from GitHub accounts): $MAX_CONCURRENT"
echo "Effective concurrency: $EFFECTIVE_CONCURRENCY"

process_character() {
    local char_index="$1"
    local work_dir="$2"
    local ai_accounts="$3"

    cd "$work_dir"

    ROLE_ID=$(echo "$RESULT" | jq -r ".characters[$char_index].role_id")
    BEST_FRAME_KEY="${TASK_ID}/character_frames/${ROLE_ID}_best.jpg"

    if [ -f "./characters/${ROLE_ID}.png" ] && [ -s "./characters/${ROLE_ID}.png" ]; then
        echo "Character $ROLE_ID already exists, skipping"
        echo "${ROLE_ID}:SUCCESS" >> "./character_results.txt"
        return 0
    fi

    echo "Processing character $ROLE_ID..."

    echo "Downloading reference image..."
    aws s3 cp "s3://$R2_BUCKET_NAME/$BEST_FRAME_KEY" "./reference_${char_index}.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL"

    INPUT_IMAGE_BASE64=$(base64 -w0 "./reference_${char_index}.jpg")

    PROMPT="American animation style character design, white background, full body portrait, professional character sheet, clean line art, vibrant colors, high quality, anime style, based on the provided reference image"

    local ACCOUNT_COUNT=$(echo "$ai_accounts" | jq -r '. | length')
    if [ "$ACCOUNT_COUNT" -eq 0 ]; then
        ACCOUNT_COUNT=1
    fi
    local START_ACCOUNT_INDEX=$((char_index % ACCOUNT_COUNT))

    MAX_RETRIES_PER_ACCOUNT=3
    RETRY_DELAY=5
    API_SUCCESS=0
    RESPONSE=""

    for account_offset in $(seq 0 $((ACCOUNT_COUNT - 1))); do
        local account_index=$(((START_ACCOUNT_INDEX + account_offset) % ACCOUNT_COUNT))

        if grep -q "^$account_index$" "./bad_accounts.txt" 2>/dev/null; then
            echo "  Character $ROLE_ID: Skipping bad account index $account_index"
            continue
        fi

        local selected_key=$(echo "$ai_accounts" | jq -r ".[$account_index].api_key_encrypted")
        local selected_url=$(echo "$ai_accounts" | jq -r ".[$account_index].base_url")
        if [ "$selected_url" = "null" ] || [ -z "$selected_url" ]; then
            selected_url="https://apihub.agnes-ai.com/v1/images/generations"
        fi

        local lock_file="./locks/account_${account_index}.lock"

        exec 200>"$lock_file"
        flock -x 200

        echo "Character $ROLE_ID: Using AI account index $account_index"

        for attempt in $(seq 1 $MAX_RETRIES_PER_ACCOUNT); do
            echo "  Character $ROLE_ID: Attempt $attempt/$MAX_RETRIES_PER_ACCOUNT..."
            echo "  Character $ROLE_ID: API URL: ${selected_url:0:50}..."
            echo "  Character $ROLE_ID: API Key: ${selected_key:0:10}..."

            RESPONSE=$(curl -s -X POST \
                --connect-timeout 30 \
                --max-time 120 \
                -w "\n%{http_code}" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $selected_key" \
                -d "{
                    \"model\": \"agnes-image-2.1-flash\",
                    \"prompt\": \"$PROMPT\",
                    \"size\": \"1024x1024\",
                    \"extra_body\": {
                        \"image\": [\"data:image/jpeg;base64,$INPUT_IMAGE_BASE64\"],
                        \"response_format\": \"url\"
                    }
                }" \
                "$selected_url")

            HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
            RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

            echo "  Character $ROLE_ID: HTTP code: $HTTP_CODE"
            if [ ${#RESPONSE_BODY} -gt 0 ]; then
                echo "  Character $ROLE_ID: Response (first 500 chars): ${RESPONSE_BODY:0:500}"
            fi

            if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
                API_SUCCESS=1
                RESPONSE="$RESPONSE_BODY"
                break 2
            fi

            if [ "$HTTP_CODE" -eq 401 ] || [ "$HTTP_CODE" -eq 403 ]; then
                local ACCOUNT_ALIAS=$(echo "$ai_accounts" | jq -r ".[$account_index].account_alias // \"Unknown\"")
                local ACCOUNT_ID=$(echo "$ai_accounts" | jq -r ".[$account_index].id // \"\"")
                echo "  Character $ROLE_ID: Account [$ACCOUNT_ALIAS] (index $account_index) returned $HTTP_CODE, marking as bad - please check this account"
                echo "$account_index" >> "./bad_accounts.txt"
                
                set +e
                curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/account-error" \
                    -H "Content-Type: application/json" \
                    -H "X-Callback-Signature: $CALLBACK_SECRET" \
                    -d "{\"task_id\":\"$TASK_ID\",\"account_id\":${ACCOUNT_ID:-null},\"error_type\":\"invalid_credentials\",\"message\":\"Account returned $HTTP_CODE\"}" > /dev/null 2>&1
                set -e
                
                flock -u 200
                break
            fi

            if [ $attempt -lt $MAX_RETRIES_PER_ACCOUNT ]; then
                sleep $RETRY_DELAY
            fi
        done

        flock -u 200

        if [ $API_SUCCESS -eq 1 ]; then
            break
        fi
    done

    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: Failed to generate character $ROLE_ID after trying all available accounts"
        rm -f "./reference_${char_index}.jpg"
        echo "${ROLE_ID}:FAILED" >> "./character_results.txt"
        return 1
    fi

    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for character $ROLE_ID"
        rm -f "./reference_${char_index}.jpg"
        echo "${ROLE_ID}:FAILED" >> "./character_results.txt"
        return 1
    fi

    echo "Downloading character image..."
    curl -s --connect-timeout 30 --max-time 60 -o "./characters/${ROLE_ID}.png" "$RESULT_URL"

    if [ ! -f "./characters/${ROLE_ID}.png" ] || [ ! -s "./characters/${ROLE_ID}.png" ]; then
        echo "Error: Downloaded character image is empty"
        rm -f "./reference_${char_index}.jpg"
        echo "${ROLE_ID}:FAILED" >> "./character_results.txt"
        return 1
    fi

    rm -f "./reference_${char_index}.jpg"
    echo "${ROLE_ID}:SUCCESS" >> "./character_results.txt"
    echo "Successfully generated character $ROLE_ID"

    return 0
}

export -f process_character
export RESULT
export TASK_ID
export R2_BUCKET_NAME
export R2_ENDPOINT_URL
export AI_API_KEY
export AI_BASE_URL

MAX_ROUNDS=3

report_progress() {
    local round=$1
    local processed=$2
    local total=$ROLE_COUNT
    local failed=$3
    local message="第${round}轮: 已完成 ${processed}/${total} 个角色"
    if [ "$failed" -gt 0 ]; then
        message="${message}, ${failed}个失败待重试"
    fi
    echo "Reporting progress: $message"
    set +e
    curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"GENERATE_CHARACTERS\",\"processed_count\":$processed,\"total_count\":$total,\"failed_count\":$failed,\"message\":\"$message\"}" > /dev/null 2>&1
    set -e
}

get_missing_indices() {
    local missing=""
    for i in $(seq 0 $((ROLE_COUNT - 1))); do
        local role_id=$(echo "$RESULT" | jq -r ".characters[$i].role_id")
        if [ ! -f "./characters/${role_id}.png" ] || [ ! -s "./characters/${role_id}.png" ]; then
            missing="${missing}${i},"
        fi
    done
    echo "${missing%,}"
}

for round in $(seq 1 $MAX_ROUNDS); do
    PENDING_INDICES=$(get_missing_indices)

    if [ -z "$PENDING_INDICES" ]; then
        echo "All characters completed at round $((round - 1))"
        break
    fi

    echo "=== Round $round/$MAX_ROUNDS: Processing characters [$PENDING_INDICES] ==="

    rm -f "./character_results.txt"

    echo "$PENDING_INDICES" | tr ',' '\n' | \
        xargs -P "$EFFECTIVE_CONCURRENCY" -I {} bash -c 'process_character "$@"' _ {} "$WORK_DIR" "$AI_ACCOUNTS" || true

    echo "Uploading character images..."
    aws s3 sync "./characters" "s3://$R2_BUCKET_NAME/${TASK_ID}/characters" \
        --endpoint-url "$R2_ENDPOINT_URL"

    SUCCESS_COUNT=$(grep -c ':SUCCESS' "./character_results.txt" 2>/dev/null || echo 0)
    FAILED_COUNT=$(grep -c ':FAILED' "./character_results.txt" 2>/dev/null || echo 0)

    TOTAL_SUCCESS=0
    TOTAL_FAILED=0
    for i in $(seq 0 $((ROLE_COUNT - 1))); do
        local_role_id=$(echo "$RESULT" | jq -r ".characters[$i].role_id")
        if [ -f "./characters/${local_role_id}.png" ] && [ -s "./characters/${local_role_id}.png" ]; then
            TOTAL_SUCCESS=$((TOTAL_SUCCESS + 1))
        else
            TOTAL_FAILED=$((TOTAL_FAILED + 1))
        fi
    done

    report_progress "$round" "$TOTAL_SUCCESS" "$TOTAL_FAILED"

    if [ "$TOTAL_FAILED" -eq 0 ]; then
        echo "=== All characters completed at round $round ==="
        break
    fi

    echo "Round $round: $TOTAL_FAILED characters still missing, will retry..."

done

FINAL_MISSING=$(get_missing_indices)
if [ -n "$FINAL_MISSING" ]; then
    FINAL_FAILED_COUNT=$(echo "$FINAL_MISSING" | tr ',' '\n' | grep -c .)
    echo "ERROR: $FINAL_FAILED_COUNT characters failed after $MAX_ROUNDS rounds: [$FINAL_MISSING]"
    exit 1
fi

echo "Character generation phase completed. All $ROLE_COUNT characters generated successfully."
