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

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Concurrency: $ACCOUNT_COUNT"

process_character() {
    local char_index="$1"
    local work_dir="$2"
    local ai_accounts="$3"
    
    cd "$work_dir"
    
    ROLE_ID=$(echo "$RESULT" | jq -r ".characters[$char_index].role_id")
    BEST_FRAME_KEY="${TASK_ID}/character_frames/${ROLE_ID}_best.jpg"
    
    echo "Processing character $ROLE_ID..."
    
    echo "Downloading reference image..."
    aws s3 cp "s3://$R2_BUCKET_NAME/$BEST_FRAME_KEY" "./reference_${char_index}.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL"
    
    INPUT_IMAGE_BASE64=$(base64 -w0 "./reference_${char_index}.jpg")
    
    PROMPT="American animation style character design, white background, full body portrait, professional character sheet, clean line art, vibrant colors, high quality, anime style, based on the provided reference image"
    
    local selected_key="$AI_API_KEY"
    local selected_url="${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations"
    
    if [ -n "$ai_accounts" ]; then
        local account_index=$((char_index % $(echo "$ai_accounts" | jq -r '. | length')))
        selected_key=$(echo "$ai_accounts" | jq -r ".[$account_index].api_key_encrypted")
        selected_url=$(echo "$ai_accounts" | jq -r ".[$account_index].base_url")
        if [ "$selected_url" = "null" ] || [ -z "$selected_url" ]; then
            selected_url="https://apihub.agnes-ai.com/v1/images/generations"
        fi
    fi
    
    local lock_file="./locks/account_${account_index}.lock"
    
    exec 200>"$lock_file"
    flock -x 200
    
    echo "Character $ROLE_ID: Using AI account index $account_index"
    
    MAX_RETRIES=3
    RETRY_DELAY=5
    API_SUCCESS=0
    RESPONSE=""
    
    for attempt in $(seq 1 $MAX_RETRIES); do
        echo "  Character $ROLE_ID: Attempt $attempt/$MAX_RETRIES..."
        
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
        
        if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            API_SUCCESS=1
            RESPONSE="$RESPONSE_BODY"
            break
        fi
        
        if [ $attempt -lt $MAX_RETRIES ]; then
            sleep $RETRY_DELAY
        fi
    done
    
    flock -u 200
    
    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: Failed to generate character $ROLE_ID"
        rm -f "./reference_${char_index}.jpg" "$lock_file"
        echo "${ROLE_ID}:FAILED" >> "./character_results.txt"
        return 1
    fi
    
    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for character $ROLE_ID"
        rm -f "./reference_${char_index}.jpg" "$lock_file"
        echo "${ROLE_ID}:FAILED" >> "./character_results.txt"
        return 1
    fi
    
    echo "Downloading character image..."
    curl -s --connect-timeout 30 --max-time 60 -o "./characters/${ROLE_ID}.png" "$RESULT_URL"
    
    if [ ! -f "./characters/${ROLE_ID}.png" ] || [ ! -s "./characters/${ROLE_ID}.png" ]; then
        echo "Error: Downloaded character image is empty"
        rm -f "./reference_${char_index}.jpg" "$lock_file"
        echo "${ROLE_ID}:FAILED" >> "./character_results.txt"
        return 1
    fi
    
    rm -f "./reference_${char_index}.jpg" "$lock_file"
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

rm -f "./character_results.txt"

echo "$RESULT" | jq -r '.characters | to_entries[] | .key' | \
    xargs -P "$ACCOUNT_COUNT" -I {} bash -c 'process_character "$@"' _ {} "$WORK_DIR" "$AI_ACCOUNTS"

SUCCESS_COUNT=$(grep -c ':SUCCESS' "./character_results.txt" 2>/dev/null || echo 0)
FAILED_COUNT=$(grep -c ':FAILED' "./character_results.txt" 2>/dev/null || echo 0)

echo "=== Character Generation Complete ==="
echo "Total: $ROLE_COUNT"
echo "Success: $SUCCESS_COUNT"
echo "Failed: $FAILED_COUNT"

echo "Uploading character images..."
aws s3 sync "./characters" "s3://$R2_BUCKET_NAME/${TASK_ID}/characters" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Character generation phase completed."