#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 3: Video Composition ==="
echo "Task ID: $TASK_ID"
echo "Output FPS: $OUTPUT_FPS"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/compose-video.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Listing AI frames..."
aws s3 ls "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_frames/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    | awk '{print $4}' | sort -V > /tmp/ai_frames_list.txt

FRAME_COUNT=$(wc -l < /tmp/ai_frames_list.txt)
echo "Composing video from $FRAME_COUNT frames..."

echo "Downloading AI frames..."
mkdir -p ./ai_frames_download

while IFS= read -r FRAME_FILE; do
    if [ -z "$FRAME_FILE" ]; then
        continue
    fi
    
    aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/ai_frames/$FRAME_FILE" "./ai_frames_download/$FRAME_FILE" \
        --endpoint-url "$R2_ENDPOINT_URL"
    
done < /tmp/ai_frames_list.txt

echo "Validating and converting AI frames..."
mkdir -p ./ai_frames_valid

for FRAME_FILE in ./ai_frames_download/*.jpg; do
    if [ ! -f "$FRAME_FILE" ] || [ ! -s "$FRAME_FILE" ]; then
        echo "Skipping invalid or empty frame: $FRAME_FILE"
        continue
    fi
    
    FRAME_NAME=$(basename "$FRAME_FILE")
    ffmpeg -i "$FRAME_FILE" -y -q:v 2 "./ai_frames_valid/$FRAME_NAME" 2>/dev/null || {
        echo "Failed to convert $FRAME_NAME, trying with different codec..."
        ffmpeg -i "$FRAME_FILE" -y -c:v mjpeg -q:v 2 "./ai_frames_valid/$FRAME_NAME" 2>/dev/null || {
            echo "Failed to convert $FRAME_NAME, skipping..."
        }
    }
done

VALID_FRAME_COUNT=$(ls ./ai_frames_valid/*.jpg 2>/dev/null | wc -l)
echo "Valid frames after conversion: $VALID_FRAME_COUNT"

echo "Creating video with ffmpeg..."
ffmpeg -framerate $OUTPUT_FPS \
    -i "./ai_frames_valid/frame_%04d.jpg" \
    -c:v libx264 \
    -profile:v high \
    -crf 20 \
    -pix_fmt yuv420p \
    "./output_video.mp4"

echo "Uploading final video to R2..."
aws s3 cp "./output_video.mp4" \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/output/video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --content-type video/mp4

FINAL_URL="$R2_ENDPOINT_URL/${TASK_ID}/output/video.mp4"
echo "Final video URL: $FINAL_URL"

echo "Notifying completion..."
MAX_RETRIES=3
RETRY_DELAY=5
SUCCESS=0

for attempt in $(seq 1 $MAX_RETRIES); do
    echo "Attempt $attempt/$MAX_RETRIES to notify completion..."
    RESP=$(curl -s -w "\n%{http_code}" -X POST "$CALLBACK_URL/complete" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"final_video_url\":\"$FINAL_URL\",\"total_frames\":$FRAME_COUNT}")
    
    HTTP_CODE=$(echo "$RESP" | tail -n1)
    echo "Completion callback code: $HTTP_CODE"
    
    if [ "$HTTP_CODE" -eq 200 ]; then
        SUCCESS=1
        break
    fi
    
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        echo "Completion notification failed, retrying in $RETRY_DELAY seconds..."
        sleep $RETRY_DELAY
    fi
done

if [ $SUCCESS -ne 1 ]; then
    echo "ERROR: Failed to notify completion after $MAX_RETRIES attempts"
    exit 1
fi

echo "Phase 3 completed successfully"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "videoPath": "${TASK_ID}/output/video.mp4",
    "videoUrl": "$FINAL_URL",
    "frameCount": $FRAME_COUNT,
    "outputFps": $OUTPUT_FPS
}
EOF