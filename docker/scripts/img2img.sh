#!/bin/bash

set -euo pipefail

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
    | awk '{print $4}' | sort > /tmp/origin_frames_list.txt

FRAME_COUNT=$(wc -l < /tmp/origin_frames_list.txt)
echo "Total frames to process: $FRAME_COUNT"

echo "Checking for already processed AI frames..."
set +e
aws s3 ls "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_frames/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    | awk '{print $4}' | sort > /tmp/ai_frames_list.txt
set -e

COMPLETED_COUNT=$(wc -l < /tmp/ai_frames_list.txt)
echo "Already processed: $COMPLETED_COUNT frames"

if [ $COMPLETED_COUNT -gt 0 ]; then
    echo "Calculating remaining frames..."
    comm -23 /tmp/origin_frames_list.txt /tmp/ai_frames_list.txt > /tmp/frames_list.txt
    REMAINING_COUNT=$(wc -l < /tmp/frames_list.txt)
    echo "Remaining frames to process: $REMAINING_COUNT"
else
    cp /tmp/origin_frames_list.txt /tmp/frames_list.txt
    REMAINING_COUNT=$FRAME_COUNT
fi

mkdir -p ./ai_frames

PROCESSED=$COMPLETED_COUNT
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
    
    MAX_RETRIES=3
    RETRY_DELAY=5
    API_SUCCESS=0
    
    set +e
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
                \"size\": \"1024x768\",
                \"extra_body\": {
                    \"image\": [\"data:image/jpeg;base64,$INPUT_IMAGE_BASE64\"],
                    \"response_format\": \"url\"
                }
            }" \
            "${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/images/generations")
        
        CURL_EXIT_CODE=$?
        
        HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
        RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')
        
        if [ $CURL_EXIT_CODE -ne 0 ]; then
            echo "  Error: curl failed with exit code $CURL_EXIT_CODE"
            if [ $attempt -lt $MAX_RETRIES ]; then
                echo "  Retrying in $RETRY_DELAY seconds..."
                sleep $RETRY_DELAY
                continue
            fi
            break
        fi
        
        echo "  HTTP Status: $HTTP_CODE"
        
        if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            API_SUCCESS=1
            RESPONSE="$RESPONSE_BODY"
            break
        fi
        
        echo "  Error response: $RESPONSE_BODY"
        
        if [ "$HTTP_CODE" -eq 429 ]; then
            echo "  Rate limited, waiting longer before retry..."
            sleep 10
        elif [ $attempt -lt $MAX_RETRIES ]; then
            echo "  Retrying in $RETRY_DELAY seconds..."
            sleep $RETRY_DELAY
        fi
    done
    set -e
    
    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: AI API call failed for frame $FRAME_FILE after $MAX_RETRIES attempts"
        FAILED=$((FAILED + 1))
        continue
    fi
    
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message // "null"' 2>/dev/null || echo "null")
    if [ "$ERROR_MSG" != "null" ] && [ "$ERROR_MSG" != "" ]; then
        echo "Error: $ERROR_MSG"
        FAILED=$((FAILED + 1))
        continue
    fi
    
    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""' 2>/dev/null || echo "")
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL returned"
        FAILED=$((FAILED + 1))
        continue
    fi
    
    echo "Downloading result from: $RESULT_URL"
    set +e
    curl -s --connect-timeout 30 --max-time 60 -o "./ai_frames/$FRAME_FILE" "$RESULT_URL"
    CURL_DOWNLOAD_EXIT=$?
    set -e
    
    if [ $CURL_DOWNLOAD_EXIT -ne 0 ] || [ ! -f "./ai_frames/$FRAME_FILE" ] || [ ! -s "./ai_frames/$FRAME_FILE" ]; then
        echo "Error: Failed to download result image"
        FAILED=$((FAILED + 1))
        continue
    fi
    
    aws s3 cp "./ai_frames/$FRAME_FILE" \
        "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_frames/$FRAME_FILE" \
        --endpoint-url "$R2_ENDPOINT_URL" \
        --content-type image/jpeg
    
    PROCESSED=$((PROCESSED + 1))
    echo "Progress: $PROCESSED / $FRAME_COUNT"
    
    rm -f ./input.jpg
    
    sleep ${COOLDOWN_SECONDS:-1}
    
    if [ $((PROCESSED % 10)) -eq 0 ]; then
        echo "Updating progress: $PROCESSED/$FRAME_COUNT..."
        set +e
        RESP=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X POST "$CALLBACK_URL/progress" \
            -H "Content-Type: application/json" \
            -H "X-Callback-Signature: $CALLBACK_SECRET" \
            -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"IMG2IMG\",\"processed_count\":$PROCESSED,\"total_count\":$FRAME_COUNT}")
        set -e
        HTTP_CODE=$(echo "$RESP" | tail -n1)
        echo "Progress callback code: $HTTP_CODE"
    fi
    
done < /tmp/frames_list.txt

echo "Phase 2 completed: $PROCESSED processed, $FAILED failed"

echo "Updating final progress..."
MAX_RETRIES=3
RETRY_DELAY=5
SUCCESS=0

for attempt in $(seq 1 $MAX_RETRIES); do
    echo "Attempt $attempt/$MAX_RETRIES to update progress..."
    set +e
    RESP=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"IMG2IMG\",\"processed_count\":$PROCESSED,\"total_count\":$FRAME_COUNT,\"failed_count\":$FAILED}")
    set -e
    
    HTTP_CODE=$(echo "$RESP" | tail -n1)
    echo "Progress callback code: $HTTP_CODE"
    
    if [ "$HTTP_CODE" -eq 200 ]; then
        SUCCESS=1
        break
    fi
    
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        echo "Progress update failed, retrying in $RETRY_DELAY seconds..."
        sleep $RETRY_DELAY
    fi
done

if [ $SUCCESS -ne 1 ]; then
    echo "ERROR: Failed to update progress after $MAX_RETRIES attempts"
    exit 1
fi

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