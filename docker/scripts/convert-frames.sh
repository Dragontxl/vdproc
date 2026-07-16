#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 6: Frame Conversion ==="
echo "Task ID: $TASK_ID"
echo "AI Account ID: $AI_ACCOUNT_ID"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/convert-frames.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

if [ -z "$AI_API_KEY" ]; then
    echo "Error: AI_API_KEY not set"
    exit 1
fi

echo "Downloading analysis result..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" "./analysis_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL"

RESULT=$(cat ./analysis_result.json)
SHOT_COUNT=$(echo "$RESULT" | jq -r '.storyboards | length')

echo "Found $SHOT_COUNT shots to process"

if [ "$SHOT_COUNT" -eq 0 ]; then
    echo "Error: No shots found in analysis_result.json"
    exit 1
fi

TOTAL_FRAMES=$((SHOT_COUNT + 1))

mkdir -p ./ai_shot_frames
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

ACQUIRE_ACCOUNT_TIMEOUT=300
ACQUIRE_ACCOUNT_INTERVAL=5

acquire_ai_account() {
    local ai_accounts="$1"
    local work_dir="$2"
    local shot_index="$3"
    local frame_type="$4"
    
    cd "$work_dir"
    
    local target_index=$(( (shot_index * 2 + (frame_type == "first" ? 0 : 1)) % ACCOUNT_COUNT ))
    local max_attempts=$((ACQUIRE_ACCOUNT_TIMEOUT / ACQUIRE_ACCOUNT_INTERVAL))
    local attempts=0
    
    while [ $attempts -lt $max_attempts ]; do
        local lock_file="./locks/account_${target_index}.lock"
        
        if (set -o noclobber; echo "$$" > "$lock_file") 2>/dev/null; then
            trap "rm -f '$lock_file'" EXIT
            
            if [ -n "$ai_accounts" ]; then
                local is_bad=$(grep -c "^${target_index}$" "./bad_accounts.txt" 2>/dev/null || echo 0)
                if [ "$is_bad" -gt 0 ]; then
                    rm -f "$lock_file"
                    attempts=$((attempts + 1))
                    sleep $ACQUIRE_ACCOUNT_INTERVAL
                    continue
                fi
            fi
            
            echo "Shot $shot_index ${frame_type}: Acquired AI account index $target_index"
            echo "$target_index"
            return 0
        fi
        
        attempts=$((attempts + 1))
        sleep $ACQUIRE_ACCOUNT_INTERVAL
    done
    
    echo "Shot $shot_index ${frame_type}: Failed to acquire AI account after $ACQUIRE_ACCOUNT_TIMEOUT seconds"
    echo "-1"
    return 1
}

release_ai_account() {
    local work_dir="$1"
    local account_index="$2"
    
    cd "$work_dir"
    local lock_file="./locks/account_${account_index}.lock"
    rm -f "$lock_file"
    echo "Released AI account index $account_index"
}

process_frame() {
    local shot_index="$1"
    local frame_type="$2"
    local work_dir="$3"
    local ai_accounts="$4"

    cd "$work_dir"

    if [ -f "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" ] && [ -s "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" ]; then
        echo "Frame shot_${shot_index}_${frame_type} already exists, skipping"
        echo "${shot_index}_${frame_type}:SUCCESS" >> "./frame_results.txt"
        return 0
    fi

    CHARACTERS=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].characters_present")

    DEFAULT_PROMPT="修改为美式动画风格，保留原始图片的元素和内容, 只改变风格。"
    MAIN_PROMPT="${PROMPT:-$DEFAULT_PROMPT}"

    FRAME_KEY="${TASK_ID}/shot_frames/shot_${shot_index}_${frame_type}.jpg"

    echo "Processing shot $shot_index, ${frame_type} frame..."

    R2_PUBLIC_URL="https://aivideobucket.ldragon.xyz"
    INPUT_IMAGE_URL="${R2_PUBLIC_URL}/${FRAME_KEY}"

    echo "  Input image URL: $INPUT_IMAGE_URL"

    CHARACTER_IMAGE_URL=""
    if [ -n "$CHARACTERS" ] && [ "$CHARACTERS" != "null" ] && [ "$CHARACTERS" != "[]" ]; then
        FIRST_CHARACTER=$(echo "$CHARACTERS" | jq -r '.[0] // ""')
        if [ -n "$FIRST_CHARACTER" ]; then
            CHAR_FRAME_KEY="${TASK_ID}/character_frames/${FIRST_CHARACTER}_best.jpg"
            CHARACTER_IMAGE_URL="${R2_PUBLIC_URL}/${CHAR_FRAME_KEY}"
            echo "  Character reference URL: $CHARACTER_IMAGE_URL"
        fi
    fi

    local account_index=$(acquire_ai_account "$ai_accounts" "$work_dir" "$shot_index" "$frame_type")
    
    if [ "$account_index" = "-1" ]; then
        echo "Error: Failed to acquire AI account for shot $shot_index, ${frame_type} frame"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    local selected_key="$AI_API_KEY"
    local selected_url="${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations"

    local selected_alias=""
    if [ -n "$ai_accounts" ]; then
        selected_key=$(echo "$ai_accounts" | jq -r ".[$account_index].api_key_encrypted")
        selected_url=$(echo "$ai_accounts" | jq -r ".[$account_index].base_url")
        selected_alias=$(echo "$ai_accounts" | jq -r ".[$account_index].account_alias")
        if [ "$selected_url" = "null" ] || [ -z "$selected_url" ]; then
            selected_url="https://apihub.agnes-ai.com/v1/images/generations"
        fi
    fi

    echo "Shot $shot_index ${frame_type}: Using AI account index $account_index (alias: $selected_alias)"

    MAX_RETRIES=5
    RETRY_DELAY=10
    API_SUCCESS=0
    RESPONSE=""

    BAD_ACCOUNTS_FILE="./bad_accounts.txt"

    for attempt in $(seq 1 $MAX_RETRIES); do
        echo "  Shot $shot_index ${frame_type}: Attempt $attempt/$MAX_RETRIES..."

        IMAGE_ARRAY="[\"$INPUT_IMAGE_URL\"]"
        if [ -n "$CHARACTER_IMAGE_URL" ]; then
            IMAGE_ARRAY="[\"$INPUT_IMAGE_URL\", \"$CHARACTER_IMAGE_URL\"]"
            echo "  Shot $shot_index ${frame_type}: Using character reference image"
        else
            echo "  Shot $shot_index ${frame_type}: No character reference available"
        fi

        RESPONSE=$(curl -s -X POST \
            --connect-timeout 30 \
            --max-time 120 \
            -w "\n%{http_code}" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $selected_key" \
            -d "{
                \"model\": \"agnes-image-2.1-flash\",
                \"prompt\": \"$MAIN_PROMPT\",
                \"size\": \"1024x768\",
                \"extra_body\": {
                    \"image\": $IMAGE_ARRAY,
                    \"response_format\": \"url\"
                }
            }" \
            "$selected_url")

        HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
        RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

        echo "  Shot $shot_index ${frame_type}: HTTP_CODE=$HTTP_CODE"
        if [ -n "$RESPONSE_BODY" ] && [ "$RESPONSE_BODY" != "null" ]; then
            echo "  Shot $shot_index ${frame_type}: Response (first 200 chars): ${RESPONSE_BODY:0:200}"
        fi

        if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            API_SUCCESS=1
            RESPONSE="$RESPONSE_BODY"
            break
        fi

        if [ "$HTTP_CODE" -eq 401 ] || [ "$HTTP_CODE" -eq 403 ]; then
            local ACCOUNT_ALIAS=$(echo "$ai_accounts" | jq -r ".[$account_index].account_alias // \"Unknown\"")
            local ACCOUNT_ID=$(echo "$ai_accounts" | jq -r ".[$account_index].id // \"\"")
            echo "  Shot $shot_index ${frame_type}: Account [$ACCOUNT_ALIAS] (index $account_index) returned $HTTP_CODE, marking as bad"
            echo "$account_index" >> "$BAD_ACCOUNTS_FILE"
            
            set +e
            curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/account-error" \
                -H "Content-Type: application/json" \
                -H "X-Callback-Signature: $CALLBACK_SECRET" \
                -d "{\"task_id\":\"$TASK_ID\",\"account_id\":${ACCOUNT_ID:-null},\"error_type\":\"invalid_credentials\",\"message\":\"Account returned $HTTP_CODE\"}" > /dev/null 2>&1
            set -e
            
            release_ai_account "$work_dir" "$account_index"
            echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
            return 1
        fi

        if [ "$HTTP_CODE" -eq 429 ] || [ "$HTTP_CODE" -eq 503 ]; then
            echo "  Shot $shot_index ${frame_type}: Rate limited ($HTTP_CODE), increasing delay"
            RETRY_DELAY=$((RETRY_DELAY * 2))
        fi

        if [ "$HTTP_CODE" -ge 500 ]; then
            echo "  Shot $shot_index ${frame_type}: Server error ($HTTP_CODE)"
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            echo "  Shot $shot_index ${frame_type}: Sleeping $RETRY_DELAY seconds before retry..."
            sleep $RETRY_DELAY
        fi
    done

    release_ai_account "$work_dir" "$account_index"

    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: Failed to convert shot $shot_index, ${frame_type} frame"
        rm -f "./input_${shot_index}_${frame_type}.jpg"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for shot $shot_index, ${frame_type} frame"
        rm -f "./input_${shot_index}_${frame_type}.jpg"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    echo "Downloading converted frame..."
    curl -s --connect-timeout 30 --max-time 60 -o "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" "$RESULT_URL"

    if [ ! -f "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" ] || [ ! -s "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" ]; then
        echo "Error: Downloaded frame is empty"
        rm -f "./input_${shot_index}_${frame_type}.jpg"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi

    rm -f "./input_${shot_index}_${frame_type}.jpg"
    echo "${shot_index}_${frame_type}:SUCCESS" >> "./frame_results.txt"
    echo "Successfully converted shot $shot_index, ${frame_type} frame"

    return 0
}

export -f process_frame
export -f acquire_ai_account
export -f release_ai_account
export RESULT
export TASK_ID
export R2_BUCKET_NAME
export R2_ENDPOINT_URL
export AI_API_KEY
export AI_BASE_URL
export ACCOUNT_COUNT
export ACQUIRE_ACCOUNT_TIMEOUT
export ACQUIRE_ACCOUNT_INTERVAL

MAX_ROUNDS=10

report_progress() {
    local round=$1
    local processed=$2
    local total=$TOTAL_FRAMES
    local failed=$3
    local message="第${round}轮: 已完成 ${processed}/${total} 个帧"
    if [ "$failed" -gt 0 ]; then
        message="${message}, ${failed}个失败待重试"
    fi
    echo "Reporting progress: $message"
    set +e
    curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"CONVERT_FRAMES\",\"processed_count\":$processed,\"total_count\":$total,\"failed_count\":$failed,\"message\":\"$message\"}" > /dev/null 2>&1
    set -e
}

get_missing_frames() {
    local missing=""
    for i in $(seq 0 $((SHOT_COUNT - 1))); do
        if [ "$i" -eq 0 ]; then
            if [ ! -f "./ai_shot_frames/shot_${i}_first.jpg" ] || [ ! -s "./ai_shot_frames/shot_${i}_first.jpg" ]; then
                missing="${missing}${i} first\n"
            fi
        fi
        if [ ! -f "./ai_shot_frames/shot_${i}_last.jpg" ] || [ ! -s "./ai_shot_frames/shot_${i}_last.jpg" ]; then
            missing="${missing}${i} last\n"
        fi
    done
    echo -e "$missing"
}

for round in $(seq 1 $MAX_ROUNDS); do
    PENDING_FRAMES=$(get_missing_frames)

    if [ -z "$(echo "$PENDING_FRAMES" | tr -d '[:space:]')" ]; then
        echo "All frames completed at round $((round - 1))"
        break
    fi

    echo "=== Round $round/$MAX_ROUNDS: Processing remaining frames ==="

    rm -f "./frame_results.txt"
    rm -f "./bad_accounts.txt"

    echo -e "$PENDING_FRAMES" | xargs -P "$EFFECTIVE_CONCURRENCY" -n 2 bash -c 'process_frame "$@"' _ || true

    echo "Uploading converted frames..."
    aws s3 sync "./ai_shot_frames" "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_shot_frames" \
        --endpoint-url "$R2_ENDPOINT_URL"

    TOTAL_SUCCESS=0
    TOTAL_FAILED=0
    for i in $(seq 0 $((SHOT_COUNT - 1))); do
        for frame_type in first last; do
            if [ -f "./ai_shot_frames/shot_${i}_${frame_type}.jpg" ] && [ -s "./ai_shot_frames/shot_${i}_${frame_type}.jpg" ]; then
                TOTAL_SUCCESS=$((TOTAL_SUCCESS + 1))
            else
                TOTAL_FAILED=$((TOTAL_FAILED + 1))
            fi
        done
    done

    report_progress "$round" "$TOTAL_SUCCESS" "$TOTAL_FAILED"

    if [ "$TOTAL_FAILED" -eq 0 ]; then
        echo "=== All frames completed at round $round ==="
        break
    fi

    echo "Round $round: $TOTAL_FAILED frames still missing, will retry..."

    if [ "$round" -lt "$MAX_ROUNDS" ]; then
        WAIT_TIME=$((round * 15))
        echo "Waiting $WAIT_TIME seconds before next round..."
        sleep $WAIT_TIME
    fi

done

FINAL_MISSING=$(get_missing_frames)
if [ -n "$(echo "$FINAL_MISSING" | tr -d '[:space:]')" ]; then
    FINAL_FAILED_COUNT=$(echo -e "$FINAL_MISSING" | grep -c .)
    echo "ERROR: $FINAL_FAILED_COUNT frames failed after $MAX_ROUNDS rounds"
    exit 1
fi

echo "Frame conversion phase completed. All $TOTAL_FRAMES frames converted successfully."