#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 8: Video Composition ==="
echo "Task ID: $TASK_ID"
echo "Output FPS: $OUTPUT_FPS"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/compose-video.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Downloading analysis result..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" "./analysis_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL"

RESULT=$(cat ./analysis_result.json)
SHOT_COUNT=$(echo "$RESULT" | jq -r '.storyboards | length')

echo "Found $SHOT_COUNT shots to compose"

mkdir -p ./downloaded_shots

echo "Downloading generated shots..."
for i in $(seq 0 $((SHOT_COUNT - 1))); do
    echo "Downloading shot $i..."
    aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots/shot_${i}.mp4" "./downloaded_shots/shot_${i}.mp4" \
        --endpoint-url "$R2_ENDPOINT_URL"
    
    if [ ! -f "./downloaded_shots/shot_${i}.mp4" ] || [ ! -s "./downloaded_shots/shot_${i}.mp4" ]; then
        echo "Warning: Shot $i is missing or empty, will skip"
    fi
done

echo "Creating concat list..."
ls -1 ./downloaded_shots/*.mp4 | sort -V | sed 's/^/file '\''/' | sed 's/$/'\''/' > ./file_list.txt

if [ ! -s ./file_list.txt ]; then
    echo "Error: No valid shot videos found"
    exit 1
fi

echo "Composing final video..."
ffmpeg -f concat -safe 0 -i ./file_list.txt -c copy "./output_video.mp4"

if [ ! -f "./output_video.mp4" ]; then
    echo "Error: Failed to compose video"
    exit 1
fi

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
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"COMPOSE\",\"data\":{\"final_video_url\":\"$FINAL_URL\",\"total_frames\":$SHOT_COUNT}}")
    
    HTTP_CODE=$(echo "$RESP" | tail -n1)
    
    if [ "$HTTP_CODE" -eq 200 ]; then
        SUCCESS=1
        break
    fi
    
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        sleep $RETRY_DELAY
    fi
done

if [ $SUCCESS -ne 1 ]; then
    echo "ERROR: Failed to notify completion"
    exit 1
fi

echo "Phase 8 completed successfully"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "videoPath": "${TASK_ID}/output/video.mp4",
    "videoUrl": "$FINAL_URL",
    "shotCount": $SHOT_COUNT
}
EOF