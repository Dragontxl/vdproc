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

SUCCESS_COUNT=0
FAILED_COUNT=0

for i in $(seq 0 $((ROLE_COUNT - 1))); do
    ROLE_ID=$(echo "$RESULT" | jq -r ".characters[$i].role_id")
    BEST_FRAME_KEY="${TASK_ID}/character_frames/${ROLE_ID}_best.jpg"
    
    echo "Processing character $ROLE_ID..."
    
    echo "Downloading reference image..."
    aws s3 cp "s3://$R2_BUCKET_NAME/$BEST_FRAME_KEY" "./reference.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL"
    
    INPUT_IMAGE_BASE64=$(base64 -w0 ./reference.jpg)
    
    PROMPT="American animation style character design, white background, full body portrait, professional character sheet, clean line art, vibrant colors, high quality, anime style, based on the provided reference image"
    
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
                \"prompt\": \"$PROMPT\",
                \"size\": \"1024x1024\",
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
        echo "Error: Failed to generate character $ROLE_ID"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        continue
    fi
    
    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for character $ROLE_ID"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        continue
    fi
    
    echo "Downloading result..."
    curl -s --connect-timeout 30 --max-time 60 -o "./characters/${ROLE_ID}.jpg" "$RESULT_URL"
    
    echo "Uploading to R2..."
    aws s3 cp "./characters/${ROLE_ID}.jpg" \
        "s3://$R2_BUCKET_NAME/${TASK_ID}/characters/${ROLE_ID}.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL" \
        --content-type image/jpeg
    
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    echo "Progress: $SUCCESS_COUNT/$ROLE_COUNT"
    
    rm -f ./reference.jpg
    sleep ${COOLDOWN_SECONDS:-1}
done

echo "Phase 4 completed: $SUCCESS_COUNT generated, $FAILED_COUNT failed"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "successCount": $SUCCESS_COUNT,
    "failedCount": $FAILED_COUNT,
    "path": "${TASK_ID}/characters/"
}
EOF