#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 2: Image-to-Image Generation ==="
echo "Task ID: $TASK_ID"
echo "AI Account ID: $AI_ACCOUNT_ID"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/img2img.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

if [ -z "$AI_API_KEY" ]; then
    echo "Error: AI_API_KEY not set"
    exit 1
fi

echo "Using AI account: $AI_ACCOUNT_ID"
echo "AI Base URL: ${AI_BASE_URL:-https://apihub.agnes-ai.com}"

echo "Listing original frames..."
aws s3 ls "s3://$R2_BUCKET_NAME/${TASK_ID}/origin_frames/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    | awk '{print $4}' > /tmp/frames_list.txt

FRAME_COUNT=$(wc -l < /tmp/frames_list.txt)
echo "Processing $FRAME_COUNT frames..."

mkdir -p ./ai_frames

PROCESSED=0
FAILED=0

while IFS= read -r FRAME_FILE; do
    if [ -z "$FRAME_FILE" ]; then
        continue
    fi
    
    echo "Processing frame: $FRAME_FILE"
    
    aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/origin_frames/$FRAME_FILE" "./input.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL"
    
    INPUT_IMAGE_BASE64=$(base64 -w0 ./input.jpg)
    
    echo "Calling AI API..."
    RESPONSE=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $AI_API_KEY" \
        -d "{
            \"model\": \"agnes-image-2.1-flash\",
            \"prompt\": \"$PROMPT\",
            \"size\": \"1024x768\",
            \"extra_body\": {
                \"image\": [\"data:image/jpeg;base64,$INPUT_IMAGE_BASE64\"],
                \"response_format\": \"url\"
            }
        }" \
        "${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations")
    
    if [ $? -ne 0 ]; then
        echo "Error: AI API call failed for frame $FRAME_FILE"
        FAILED=$((FAILED + 1))
        continue
    fi
    
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message')
    if [ "$ERROR_MSG" != "null" ]; then
        echo "Error: $ERROR_MSG"
        FAILED=$((FAILED + 1))
        continue
    fi
    
    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url')
    if [ "$RESULT_URL" == "null" ] || [ "$RESULT_URL" == "" ]; then
        echo "Error: No result URL returned"
        FAILED=$((FAILED + 1))
        continue
    fi
    
    echo "Downloading result from: $RESULT_URL"
    curl -s -o "./ai_frames/$FRAME_FILE" "$RESULT_URL"
    
    aws s3 cp "./ai_frames/$FRAME_FILE" \
        "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_frames/$FRAME_FILE" \
        --endpoint-url "$R2_ENDPOINT_URL" \
        --content-type image/jpeg
    
    PROCESSED=$((PROCESSED + 1))
    echo "Progress: $PROCESSED / $FRAME_COUNT"
    
    rm -f ./input.jpg
    
    sleep ${COOLDOWN_SECONDS:-1}
    
    if [ $((PROCESSED % 10)) -eq 0 ]; then
        curl -s -X POST "$CALLBACK_URL/progress" \
            -H "Content-Type: application/json" \
            -H "X-Callback-Signature: $CALLBACK_SECRET" \
            -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"IMG2IMG\",\"processed_count\":$PROCESSED,\"total_count\":$FRAME_COUNT}"
    fi
    
done < /tmp/frames_list.txt

echo "Phase 2 completed: $PROCESSED processed, $FAILED failed"

curl -s -X POST "$CALLBACK_URL/progress" \
    -H "Content-Type: application/json" \
    -H "X-Callback-Signature: $CALLBACK_SECRET" \
    -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"IMG2IMG\",\"processed_count\":$PROCESSED,\"total_count\":$FRAME_COUNT,\"failed_count\":$FAILED}"

cat > /tmp/result.json <<EOF
{
    "frames": [],
    "totalCount": $FRAME_COUNT,
    "processedCount": $PROCESSED,
    "failedCount": $FAILED,
    "path": "${TASK_ID}/ai_frames/",
    "taskId": "$TASK_ID"
}
EOF