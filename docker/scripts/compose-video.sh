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

echo "Creating video with ffmpeg..."
ffmpeg -framerate $OUTPUT_FPS \
    -i "./ai_frames_download/frame_%04d.jpg" \
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
curl -s -X POST "$CALLBACK_URL/complete" \
    -H "Content-Type: application/json" \
    -H "X-Callback-Signature: $CALLBACK_SECRET" \
    -d "{\"task_id\":\"$TASK_ID\",\"final_video_url\":\"$FINAL_URL\",\"total_frames\":$FRAME_COUNT}"

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