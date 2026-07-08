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
SHOT_COUNT=$(echo "$RESULT" | jq -r '.shots | length')

echo "Found $SHOT_COUNT shots to process"

mkdir -p ./ai_shot_frames

SUCCESS_COUNT=0
FAILED_COUNT=0
TOTAL_FRAMES=$((SHOT_COUNT * 2))

for i in $(seq 0 $((SHOT_COUNT - 1))); do
    CHARACTERS=$(echo "$RESULT" | jq -r ".shots[$i].characters")
    POSITIVE_PROMPT=$(echo "$RESULT" | jq -r ".shots[$i].positive_prompt")
    NEGATIVE_PROMPT=$(echo "$RESULT" | jq -r ".shots[$i].negative_prompt")
    
    MAIN_PROMPT="$POSITIVE_PROMPT, American animation style, anime style, high quality"
    if [ -n "$NEGATIVE_PROMPT" ]; then
        MAIN_PROMPT="$MAIN_PROMPT, negative prompt: $NEGATIVE_PROMPT"
    fi
    
    for frame_type in first last; do
        FRAME_KEY="${TASK_ID}/shot_frames/shot_${i}_${frame_type}.jpg"
        
        echo "Processing shot $i, ${frame_type} frame..."
        
        aws s3 cp "s3://$R2_BUCKET_NAME/$FRAME_KEY" "./input.jpg" \
            --endpoint-url "$R2_ENDPOINT_URL"
        
        INPUT_IMAGE_BASE64=$(base64 -w0 ./input.jpg)
        
        MAX_RETRIES=3
        RETRY_DELAY=5
        API_SUCCESS=0
        
        for attempt in $(seq 1 $MAX_RETRIES); do
            echo "  Attempt $attempt/$MAX_RETRIES..."
            
            RESPONSE=$(curl -s -X POST \
                --connect-timeout 30 \
                --max-time 120 \
                -w "\n%{http_code}" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $AI_API_KEY" \
                -d "{
                    \"model\": \"agnes-image-2.1-flash\",
                    \"prompt\": \"$MAIN_PROMPT\",
                    \"size\": \"1024x768\",
                    \"extra_body\": {
                        \"image\": [\"data:image/jpeg;base64,$INPUT_IMAGE_BASE64\"],
                        \"response_format\": \"url\"
                    }
                }" \
                "${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations")
            
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
        
        if [ $API_SUCCESS -ne 1 ]; then
            echo "Error: Failed to convert shot $i ${frame_type} frame"
            FAILED_COUNT=$((FAILED_COUNT + 1))
            rm -f ./input.jpg
            continue
        fi
        
        RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
        if [ -z "$RESULT_URL" ]; then
            echo "Error: No result URL"
            FAILED_COUNT=$((FAILED_COUNT + 1))
            rm -f ./input.jpg
            continue
        fi
        
        curl -s --connect-timeout 30 --max-time 60 -o "./ai_shot_frames/shot_${i}_${frame_type}.jpg" "$RESULT_URL"
        
        aws s3 cp "./ai_shot_frames/shot_${i}_${frame_type}.jpg" \
            "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_shot_frames/shot_${i}_${frame_type}.jpg" \
            --endpoint-url "$R2_ENDPOINT_URL" \
            --content-type image/jpeg
        
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        echo "Progress: $SUCCESS_COUNT/$TOTAL_FRAMES"
        
        rm -f ./input.jpg
        sleep ${COOLDOWN_SECONDS:-1}
    done
done

echo "Phase 6 completed: $SUCCESS_COUNT converted, $FAILED_COUNT failed"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "successCount": $SUCCESS_COUNT,
    "failedCount": $FAILED_COUNT,
    "path": "${TASK_ID}/ai_shot_frames/"
}
EOF