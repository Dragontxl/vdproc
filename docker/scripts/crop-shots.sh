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

echo "Getting video duration..."
VIDEO_DURATION=$(ffmpeg -i ./input_video.mp4 2>&1 | grep -oP 'Duration: \K[0-9:.]+')
echo "Video duration: $VIDEO_DURATION"

VIDEO_SECONDS=$(echo "$VIDEO_DURATION" | awk -F: '{print ($1 * 3600) + ($2 * 60) + $3}')
echo "Video duration in seconds: $VIDEO_SECONDS"

for i in $(seq 0 $((SHOT_COUNT - 1))); do
    START_TIME=$(echo "$RESULT" | jq -r ".storyboards[$i].start_time")
    END_TIME=$(echo "$RESULT" | jq -r ".storyboards[$i].end_time")
    
    echo "Processing shot $i: $START_TIME -> $END_TIME"
    
    END_SECONDS=$(echo "$END_TIME" | awk -F: '{print ($1 * 3600) + ($2 * 60) + $3}')
    echo "End time in seconds: $END_SECONDS"
    
    if [ "$i" -eq 0 ]; then
        echo "Extracting first frame (shot_0 only)..."
        ffmpeg -ss "$START_TIME" -i ./input_video.mp4 -vframes 1 -q:v 2 "./shot_frames/shot_${i}_first.jpg"
    fi
    
    echo "Extracting last frame..."
    ffmpeg -ss "$END_TIME" -i ./input_video.mp4 -vframes 1 -q:v 2 "./shot_frames/shot_${i}_last.jpg" 2>&1 || true
    
    if [ ! -f "./shot_frames/shot_${i}_last.jpg" ]; then
        echo "Failed to extract last frame at $END_TIME, trying -sseof (0.5s before end)..."
        ffmpeg -sseof -0.5 -i ./input_video.mp4 -vframes 1 -q:v 2 "./shot_frames/shot_${i}_last.jpg" 2>&1 || true
    fi
    
    if [ ! -f "./shot_frames/shot_${i}_last.jpg" ]; then
        echo "Failed to extract last frame, trying fallback..."
        if [ "$i" -eq 0 ] && [ -f "./shot_frames/shot_${i}_first.jpg" ]; then
            cp "./shot_frames/shot_${i}_first.jpg" "./shot_frames/shot_${i}_last.jpg"
        else
            PREV_LAST="./shot_frames/shot_$((i-1))_last.jpg"
            if [ -f "$PREV_LAST" ]; then
                cp "$PREV_LAST" "./shot_frames/shot_${i}_last.jpg"
            fi
        fi
        echo "Using fallback for last frame"
    fi
    
    echo "Cropping shot video..."
    ffmpeg -ss "$START_TIME" -to "$END_TIME" -i ./input_video.mp4 -c:v libx264 -crf 20 -pix_fmt yuv420p "./shot_videos/shot_${i}.mp4"
done

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