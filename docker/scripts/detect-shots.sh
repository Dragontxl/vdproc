#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 1: Shot Detection ==="
echo "Task ID: $TASK_ID"
echo "Video Path: $VIDEO_PATH"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/detect-shots.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Downloading video from R2..."
aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Running PySceneDetect..."
scenedetect -i "./input_video.mp4" detect-content list-scenes -o "./scenes"

echo "Parsing scene detection results..."
SCENE_FILE="./scenes/scenes.csv"
if [ ! -f "$SCENE_FILE" ]; then
    echo "Error: Scene detection failed, no output file"
    exit 1
fi

SHOT_COUNT=0
while IFS=',' read -r frame_num time_code scene_num start_frame end_frame duration; do
    if [[ "$frame_num" == "Frame Number" ]]; then
        continue
    fi
    
    START_TIME=$(echo "$time_code" | awk -F' --> ' '{print $1}')
    END_TIME=$(echo "$time_code" | awk -F' --> ' '{print $2}')
    
    START_SEC=$(python3 -c "
from datetime import datetime
t = datetime.strptime('$START_TIME', '%H:%M:%S.%f')
print(t.hour * 3600 + t.minute * 60 + t.second + t.microsecond / 1000000)
")
    
    END_SEC=$(python3 -c "
from datetime import datetime
t = datetime.strptime('$END_TIME', '%H:%M:%S.%f')
print(t.hour * 3600 + t.minute * 60 + t.second + t.microsecond / 1000000)
")
    
    DURATION=$(echo "$END_SEC - $START_SEC" | bc)
    
    echo "Shot $SHOT_COUNT: $START_SEC -> $END_SEC (duration: $DURATION)"
    
    SHOT_COUNT=$((SHOT_COUNT + 1))
done < "$SCENE_FILE"

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