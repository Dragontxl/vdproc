#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 1: Shot Detection ==="
echo "Task ID: $TASK_ID"
echo "Video Path: $VIDEO_PATH"
echo "R2 Bucket: $R2_BUCKET_NAME"
echo "R2 Endpoint: $R2_ENDPOINT_URL"
echo "R2 Access Key: ${R2_ACCESS_KEY_ID:0:8}..."

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/detect-shots.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Listing R2 bucket contents..."
aws s3 ls "s3://$R2_BUCKET_NAME/" --endpoint-url "$R2_ENDPOINT_URL"

echo "Downloading video from R2..."
aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Running PySceneDetect..."
scenedetect -i "./input_video.mp4" detect-content list-scenes -o "./scenes"

echo "Parsing scene detection results..."
ls -la ./scenes/
SCENE_FILE="./scenes/input_video-Scenes.csv"
if [ ! -f "$SCENE_FILE" ]; then
    echo "Error: Scene detection failed, no output file"
    exit 1
fi

echo "CSV file content:"
cat "$SCENE_FILE"

SHOT_COUNT=$(python3 -c "
import csv

count = 0
with open('$SCENE_FILE', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        count += 1
        start_time = row.get('Start Time', row.get('Time Code', '').split(' --> ')[0] if ' --> ' in row.get('Time Code', '') else '')
        end_time = row.get('End Time', row.get('Time Code', '').split(' --> ')[1] if ' --> ' in row.get('Time Code', '') else '')
        print(f'Shot {count}: {start_time} -> {end_time}')
print(f'Total shots: {count}')
")

SHOT_COUNT=$(python3 -c "
import csv
count = 0
with open('$SCENE_FILE', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        count += 1
print(count)
")

echo "Total shots detected: $SHOT_COUNT"

echo "Uploading scene detection results..."
aws s3 cp "./scenes/" \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/scenes/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --recursive

echo "Updating progress..."
MAX_RETRIES=3
RETRY_DELAY=5
SUCCESS=0

for attempt in $(seq 1 $MAX_RETRIES); do
    echo "Attempt $attempt/$MAX_RETRIES to update progress..."
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"DETECT\",\"processed_count\":$SHOT_COUNT,\"total_count\":$SHOT_COUNT}")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" -eq 200 ]; then
        SUCCESS=1
        break
    fi
    
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        sleep $RETRY_DELAY
    fi
done

if [ $SUCCESS -ne 1 ]; then
    echo "ERROR: Failed to update progress"
    exit 1
fi

echo "Phase 1 completed: $SHOT_COUNT shots detected"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "shotCount": $SHOT_COUNT,
    "path": "${TASK_ID}/scenes/"
}
EOF