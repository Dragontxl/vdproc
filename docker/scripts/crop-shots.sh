#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 5: Shot Cropping ==="
echo "Task ID: $TASK_ID"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/crop-shots.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Downloading video from R2..."
aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Downloading analysis result..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" "./analysis_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL"

RESULT=$(cat ./analysis_result.json)
SHOT_COUNT=$(echo "$RESULT" | jq -r '.storyboards | length')

echo "Found $SHOT_COUNT shots to process"

mkdir -p ./shot_frames
mkdir -p ./shot_videos

FAILED_SHOTS=""

for i in $(seq 0 $((SHOT_COUNT - 1))); do
    START_TIME=$(echo "$RESULT" | jq -r ".storyboards[$i].start_time")
    END_TIME=$(echo "$RESULT" | jq -r ".storyboards[$i].end_time")
    
    echo "Processing shot $i: $START_TIME -> $END_TIME"
    
    echo "Extracting first frame..."
    ffmpeg -y -i ./input_video.mp4 -ss "$START_TIME" -vframes 1 -q:v 2 "./shot_frames/shot_${i}_first.jpg"
    
    if [ ! -f "./shot_frames/shot_${i}_first.jpg" ] || [ ! -s "./shot_frames/shot_${i}_first.jpg" ]; then
        echo "Error: Failed to extract first frame for shot $i"
        FAILED_SHOTS="$FAILED_SHOTS shot_${i}_first"
    fi
    
    echo "Extracting last frame..."
    ffmpeg -y -i ./input_video.mp4 -ss "$END_TIME" -vframes 1 -q:v 2 "./shot_frames/shot_${i}_last.jpg"
    
    if [ ! -f "./shot_frames/shot_${i}_last.jpg" ] || [ ! -s "./shot_frames/shot_${i}_last.jpg" ]; then
        echo "Error: Failed to extract last frame for shot $i at $END_TIME, trying 0.1s before..."
        END_TIME_ADJUSTED=$(echo "$END_TIME" | awk -F: '{h=$1; m=$2; s=$3; total=h*3600+m*60+s-0.1; printf "%02d:%02d:%06.3f\n", int(total/3600), int((total%3600)/60), total%60}')
        ffmpeg -y -i ./input_video.mp4 -ss "$END_TIME_ADJUSTED" -vframes 1 -q:v 2 "./shot_frames/shot_${i}_last.jpg"
    fi
    
    if [ ! -f "./shot_frames/shot_${i}_last.jpg" ] || [ ! -s "./shot_frames/shot_${i}_last.jpg" ]; then
        echo "Error: Failed to extract last frame for shot $i"
        FAILED_SHOTS="$FAILED_SHOTS shot_${i}_last"
    fi
    
    echo "Cropping shot video..."
    ffmpeg -y -i ./input_video.mp4 -ss "$START_TIME" -to "$END_TIME" -c:v libx264 -crf 20 -pix_fmt yuv420p "./shot_videos/shot_${i}.mp4"
    
    if [ ! -f "./shot_videos/shot_${i}.mp4" ] || [ ! -s "./shot_videos/shot_${i}.mp4" ]; then
        echo "Error: Failed to crop video for shot $i"
        FAILED_SHOTS="$FAILED_SHOTS shot_${i}_video"
    fi
done

if [ -n "$FAILED_SHOTS" ]; then
    echo "Error: Failed to process the following items:$FAILED_SHOTS"
    exit 1
fi

echo "Uploading shot frames..."
aws s3 cp ./shot_frames/ \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/shot_frames/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --recursive \
    --content-type image/jpeg

echo "Uploading shot videos..."
aws s3 cp ./shot_videos/ \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/shot_videos/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --recursive \
    --content-type video/mp4

echo "Phase 5 completed: $SHOT_COUNT shots processed"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "shotCount": $SHOT_COUNT,
    "framesPath": "${TASK_ID}/shot_frames/",
    "videosPath": "${TASK_ID}/shot_videos/"
}
EOF