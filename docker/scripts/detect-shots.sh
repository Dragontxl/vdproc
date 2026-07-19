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

echo "Running PySceneDetect with PyAV backend..."
scenedetect -i "./input_video.mp4" -b pyav detect-content list-scenes -o "./scenes"

echo "Parsing scene detection results..."
ls -la ./scenes/
SCENE_FILE="./scenes/input_video-Scenes.csv"
if [ ! -f "$SCENE_FILE" ]; then
    echo "Error: Scene detection failed, no output file"
    exit 1
fi

echo "CSV file content:"
cat "$SCENE_FILE"

python3 << 'PYTHON_SCRIPT'
import csv
import json
import sys

scene_data = []
with open('./scenes/input_video-Scenes.csv', 'r') as f:
    reader = csv.reader(f)
    lines = list(reader)
    if len(lines) < 2:
        sys.stderr.write('Error: CSV file too short\n')
        sys.exit(1)
    
    headers = lines[1]
    sys.stderr.write('CSV Headers: ' + str(headers) + '\n')
    
    for row in lines[2:]:
        if len(row) == 0:
            continue
        row_dict = dict(zip(headers, row))
        sys.stderr.write('Row: ' + str(row_dict) + '\n')
        scene_data.append({
            'scene_number': int(row_dict.get('Scene Number', '0')),
            'start_frame': int(row_dict.get('Start Frame', '0')),
            'start_timecode': row_dict.get('Start Timecode', ''),
            'start_time_seconds': float(row_dict.get('Start Time (seconds)', '0')),
            'end_frame': int(row_dict.get('End Frame', '0')),
            'end_timecode': row_dict.get('End Timecode', ''),
            'end_time_seconds': float(row_dict.get('End Time (seconds)', '0')),
            'length_frames': int(row_dict.get('Length (frames)', '0')),
            'length_seconds': float(row_dict.get('Length (seconds)', '0'))
        })

sys.stderr.write(f'Total shots: {len(scene_data)}\n')

with open('./scenes/scenes.json', 'w') as f:
    json.dump(scene_data, f, indent=2)

sys.stderr.write('Generated scenes.json\n')
print(len(scene_data))
PYTHON_SCRIPT
SHOT_COUNT=$(python3 << 'PYTHON_SCRIPT'
import csv

with open('./scenes/input_video-Scenes.csv', 'r') as f:
    reader = csv.reader(f)
    lines = list(reader)
    print(max(0, len(lines) - 2))
PYTHON_SCRIPT
)

echo "Total shots detected: $SHOT_COUNT"

if ! [[ "$SHOT_COUNT" =~ ^[0-9]+$ ]]; then
    echo "Error: SHOT_COUNT is not a valid number"
    exit 1
fi

if [ "$SHOT_COUNT" -eq 0 ]; then
    echo "Error: No shots detected"
    exit 1
fi

echo "Uploading scene detection results..."
aws s3 cp "./scenes/" \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/scenes/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --recursive

echo "Updating progress..."
echo "CALLBACK_URL: $CALLBACK_URL"
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
    BODY=$(echo "$RESPONSE" | head -n -1)
    
    echo "Progress callback response code: $HTTP_CODE"
    echo "Progress callback response body: $BODY"
    
    if [ "$HTTP_CODE" -eq 200 ]; then
        SUCCESS=1
        break
    fi
    
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        sleep $RETRY_DELAY
    fi
done

if [ $SUCCESS -ne 1 ]; then
    echo "WARNING: Failed to update progress, continuing..."
fi

echo "Phase 1 completed: $SHOT_COUNT shots detected"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "shotCount": $SHOT_COUNT,
    "path": "${TASK_ID}/scenes/"
}
EOF