#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 1: Frame Extraction ==="
echo "Task ID: $TASK_ID"
echo "Video Path: $VIDEO_PATH"
echo "FPS: $FPS"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/extract-frames.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Downloading video from R2..."
aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Extracting frames at $FPS FPS..."
mkdir -p ./origin_frames

ffmpeg -i ./input_video.mp4 \
    -r $FPS \
    -f image2 \
    -q:v 2 \
    -vf "scale=1024:1024:force_original_aspect_ratio=increase,crop=1024:1024" \
    "./origin_frames/frame_%04d.jpg"

FRAME_COUNT=$(ls ./origin_frames/*.jpg 2>/dev/null | wc -l)
echo "Extracted $FRAME_COUNT frames"

echo "Uploading frames to R2..."
aws s3 cp ./origin_frames/ \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/origin_frames/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --recursive \
    --content-type image/jpeg

echo "Updating progress..."
MAX_RETRIES=3
RETRY_DELAY=5
SUCCESS=0

for attempt in $(seq 1 $MAX_RETRIES); do
    echo "Attempt $attempt/$MAX_RETRIES to update progress..."
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"EXTRACT\",\"processed_count\":$FRAME_COUNT,\"total_count\":$FRAME_COUNT}")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | head -n -1)
    
    echo "Progress callback response code: $HTTP_CODE"
    echo "Progress callback response body: $BODY"
    
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

echo "Phase 1 completed: $FRAME_COUNT frames extracted"

cat > /tmp/result.json <<EOF
{
    "frames": [],
    "totalCount": $FRAME_COUNT,
    "processedCount": $FRAME_COUNT,
    "path": "${TASK_ID}/origin_frames/",
    "taskId": "$TASK_ID"
}
EOF