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

mkdir -p ./ai_shot_frames
mkdir -p ./locks

ACCOUNT_COUNT=1
if [ -n "$AI_ACCOUNTS" ]; then
    ACCOUNT_COUNT=$(echo "$AI_ACCOUNTS" | jq -r '. | length')
fi

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Concurrency: $ACCOUNT_COUNT"

process_frame() {
    local shot_index="$1"
    local frame_type="$2"
    local work_dir="$3"
    local ai_accounts="$4"
    
    cd "$work_dir"
    
    CHARACTERS=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].characters_present")
    POSITIVE_PROMPT=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].positive_prompt")
    NEGATIVE_PROMPT=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].negative_prompt")
    
    MAIN_PROMPT="$POSITIVE_PROMPT, American animation style, anime style, high quality"
    if [ -n "$NEGATIVE_PROMPT" ]; then
        MAIN_PROMPT="$MAIN_PROMPT, negative prompt: $NEGATIVE_PROMPT"
    fi
    
    FRAME_KEY="${TASK_ID}/shot_frames/shot_${shot_index}_${frame_type}.jpg"
    
    echo "Processing shot $shot_index, ${frame_type} frame..."
    
    aws s3 cp "s3://$R2_BUCKET_NAME/$FRAME_KEY" "./input_${shot_index}_${frame_type}.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL"
    
    INPUT_IMAGE_BASE64=$(base64 -w0 "./input_${shot_index}_${frame_type}.jpg")
    
    local selected_key="$AI_API_KEY"
    local selected_url="${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations"
    
    if [ -n "$ai_accounts" ]; then
        local account_index=$(( (shot_index * 2 + (frame_type == "first" ? 0 : 1)) % $(echo "$ai_accounts" | jq -r '. | length') ))
        selected_key=$(echo "$ai_accounts" | jq -r ".[$account_index].api_key_encrypted")
        selected_url=$(echo "$ai_accounts" | jq -r ".[$account_index].base_url")
        if [ "$selected_url" = "null" ] || [ -z "$selected_url" ]; then
            selected_url="https://apihub.agnes-ai.com/v1/images/generations"
        fi
    fi
    
    local lock_file="./locks/account_${account_index}.lock"
    
    exec 200>"$lock_file"
    flock -x 200
    
    echo "Shot $shot_index ${frame_type}: Using AI account index $account_index"
    
    MAX_RETRIES=3
    RETRY_DELAY=5
    API_SUCCESS=0
    RESPONSE=""
    
    for attempt in $(seq 1 $MAX_RETRIES); do
        echo "  Shot $shot_index ${frame_type}: Attempt $attempt/$MAX_RETRIES..."
        
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
        echo "Error: Failed to convert shot $shot_index, ${frame_type} frame"
        rm -f "./input_${shot_index}_${frame_type}.jpg" "$lock_file"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi
    
    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for shot $shot_index, ${frame_type} frame"
        rm -f "./input_${shot_index}_${frame_type}.jpg" "$lock_file"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi
    
    echo "Downloading converted frame..."
    curl -s --connect-timeout 30 --max-time 60 -o "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" "$RESULT_URL"
    
    if [ ! -f "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" ] || [ ! -s "./ai_shot_frames/shot_${shot_index}_${frame_type}.jpg" ]; then
        echo "Error: Downloaded frame is empty"
        rm -f "./input_${shot_index}_${frame_type}.jpg" "$lock_file"
        echo "${shot_index}_${frame_type}:FAILED" >> "./frame_results.txt"
        return 1
    fi
    
    rm -f "./input_${shot_index}_${frame_type}.jpg" "$lock_file"
    echo "${shot_index}_${frame_type}:SUCCESS" >> "./frame_results.txt"
    echo "Successfully converted shot $shot_index, ${frame_type} frame"
    
    return 0
}

export -f process_frame
export RESULT
export TASK_ID
export R2_BUCKET_NAME
export R2_ENDPOINT_URL
export AI_API_KEY
export AI_BASE_URL

rm -f "./frame_results.txt"

for i in $(seq 0 $((SHOT_COUNT - 1))); do
    for frame_type in first last; do
        echo "$i $frame_type"
    done
done | xargs -P "$ACCOUNT_COUNT" -n 2 bash -c 'process_frame "$@"' _

SUCCESS_COUNT=$(grep -c ':SUCCESS' "./frame_results.txt" 2>/dev/null || echo 0)
FAILED_COUNT=$(grep -c ':FAILED' "./frame_results.txt" 2>/dev/null || echo 0)

echo "=== Frame Conversion Complete ==="
echo "Total: $((SHOT_COUNT * 2))"
echo "Success: $SUCCESS_COUNT"
echo "Failed: $FAILED_COUNT"

echo "Uploading converted frames..."
aws s3 sync "./ai_shot_frames" "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_shot_frames" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Frame conversion phase completed."