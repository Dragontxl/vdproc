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

SHOT_COUNT=$(python3 << 'PYTHON_SCRIPT'
import csv
import json
import math
import os
import sys

# 最大场景时长（秒），超过则均匀切分
MAX_SCENE_DURATION = float(os.environ.get('MAX_SCENE_DURATION', '30'))

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

sys.stderr.write(f'Original scenes: {len(scene_data)}\n')
sys.stderr.write(f'MAX_SCENE_DURATION: {MAX_SCENE_DURATION}s\n')

# 对超长场景进行均匀切分
final_scenes = []
split_count = 0
for scene in scene_data:
    duration = scene['length_seconds']
    if duration <= MAX_SCENE_DURATION:
        # 不超过阈值，原样保留
        final_scenes.append(scene)
    else:
        # 超过阈值，均匀切分为 n 个子场景（每个 <= MAX_SCENE_DURATION）
        n = math.ceil(duration / MAX_SCENE_DURATION)
        sub_duration = duration / n
        # 用该场景的帧数/时长推算 fps，确保切分点帧对齐
        fps = scene['length_frames'] / scene['length_seconds'] if scene['length_seconds'] > 0 else 30
        
        parent_num = scene['scene_number']
        sys.stderr.write(f'Splitting scene {parent_num} (duration={duration:.3f}s) into {n} sub-scenes (each ~{sub_duration:.3f}s)\n')
        
        for i in range(n):
            # 最后一个子场景的 end_time 用原始场景的 end_time，避免浮点误差导致丢失帧
            sub_start_time = scene['start_time_seconds'] + i * sub_duration
            sub_end_time = scene['start_time_seconds'] + (i + 1) * sub_duration if i < n - 1 else scene['end_time_seconds']
            sub_start_frame = int(round(sub_start_time * fps))
            sub_end_frame = int(round(sub_end_time * fps))
            sub_length_frames = sub_end_frame - sub_start_frame
            sub_length_seconds = sub_end_time - sub_start_time
            
            final_scenes.append({
                'scene_number': 0,  # 占位，后面统一重新编号
                'start_frame': sub_start_frame,
                'start_timecode': '',  # 切分点无对应 timecode，留空
                'start_time_seconds': round(sub_start_time, 3),
                'end_frame': sub_end_frame,
                'end_timecode': '',
                'end_time_seconds': round(sub_end_time, 3),
                'length_frames': sub_length_frames,
                'length_seconds': round(sub_length_seconds, 3),
                'parent_scene_number': parent_num,  # 记录原始场景号，便于追溯
                'sub_index': i  # 子场景序号（从0开始）
            })
            split_count += 1

# 重新编号所有场景的 scene_number（从1开始连续）
for idx, scene in enumerate(final_scenes):
    scene['scene_number'] = idx + 1

sys.stderr.write(f'Split {split_count} sub-scenes from long scenes\n')
sys.stderr.write(f'Final scenes: {len(final_scenes)}\n')

with open('./scenes/scenes.json', 'w') as f:
    json.dump(final_scenes, f, indent=2)

sys.stderr.write('Generated scenes.json\n')
print(len(final_scenes))
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