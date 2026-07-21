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
    
    START_SECONDS=$(echo "$START_TIME" | awk -F: '{print ($1 * 3600) + ($2 * 60) + $3}')
    END_SECONDS=$(echo "$END_TIME" | awk -F: '{print ($1 * 3600) + ($2 * 60) + $3}')
    echo "Start time in seconds: $START_SECONDS"
    echo "End time in seconds: $END_SECONDS"
    
    if awk "BEGIN {exit !($END_SECONDS <= $START_SECONDS)}"; then
        echo "Warning: end_time ($END_TIME) <= start_time ($START_TIME), fixing..."
        if [ "$i" -lt $((SHOT_COUNT - 1)) ]; then
            NEXT_START=$(echo "$RESULT" | jq -r ".storyboards[$((i+1))].start_time")
            NEXT_START_SECONDS=$(echo "$NEXT_START" | awk -F: '{print ($1 * 3600) + ($2 * 60) + $3}')
            if awk "BEGIN {exit !($NEXT_START_SECONDS > $START_SECONDS)}"; then
                END_TIME="$NEXT_START"
                END_SECONDS="$NEXT_START_SECONDS"
                echo "  Fixed: using next shot start_time as end_time: $END_TIME"
            else
                END_SECONDS=$(awk "BEGIN {print $START_SECONDS + 5}")
                END_HOURS=$(printf "%02d" $(awk "BEGIN {print int($END_SECONDS / 3600)}"))
                END_MINS=$(printf "%02d" $(awk "BEGIN {print int(($END_SECONDS % 3600) / 60)}"))
                END_SECS=$(printf "%06.3f" $(awk "BEGIN {print $END_SECONDS % 60}"))
                END_TIME="${END_HOURS}:${END_MINS}:${END_SECS}"
                echo "  Fixed: adding 5s to start_time: $END_TIME"
            fi
        else
            END_SECONDS="$VIDEO_SECONDS"
            END_HOURS=$(printf "%02d" $(awk "BEGIN {print int($END_SECONDS / 3600)}"))
            END_MINS=$(printf "%02d" $(awk "BEGIN {print int(($END_SECONDS % 3600) / 60)}"))
            END_SECS=$(printf "%06.3f" $(awk "BEGIN {print $END_SECONDS % 60}"))
            END_TIME="${END_HOURS}:${END_MINS}:${END_SECS}"
            echo "  Fixed: using video duration as end_time: $END_TIME"
        fi
    fi
    
    if awk "BEGIN {exit !($END_SECONDS > $VIDEO_SECONDS)}"; then
        echo "Warning: end_time ($END_TIME) exceeds video duration, clamping..."
        END_SECONDS="$VIDEO_SECONDS"
        END_HOURS=$(printf "%02d" $(awk "BEGIN {print int($END_SECONDS / 3600)}"))
        END_MINS=$(printf "%02d" $(awk "BEGIN {print int(($END_SECONDS % 3600) / 60)}"))
        END_SECS=$(printf "%06.3f" $(awk "BEGIN {print $END_SECONDS % 60}"))
        END_TIME="${END_HOURS}:${END_MINS}:${END_SECS}"
        echo "  Fixed end_time: $END_TIME"
    fi
    
    if [ "$i" -gt 0 ]; then
        PREV_END_TIME=$(echo "$RESULT" | jq -r ".storyboards[$((i-1))].end_time")
        PREV_END_SECONDS=$(echo "$PREV_END_TIME" | awk -F: '{print ($1 * 3600) + ($2 * 60) + $3}')
        if awk "BEGIN {exit !($START_SECONDS < $PREV_END_SECONDS)}"; then
            echo "Warning: start_time ($START_TIME) < previous end_time ($PREV_END_TIME), fixing..."
            START_SECONDS="$PREV_END_SECONDS"
            START_HOURS=$(printf "%02d" $(awk "BEGIN {print int($START_SECONDS / 3600)}"))
            START_MINS=$(printf "%02d" $(awk "BEGIN {print int(($START_SECONDS % 3600) / 60)}"))
            START_SECS=$(printf "%06.3f" $(awk "BEGIN {print $START_SECONDS % 60}"))
            START_TIME="${START_HOURS}:${START_MINS}:${START_SECS}"
            echo "  Fixed start_time: $START_TIME"
        fi
    fi
    
    echo "Extracting first frame..."
    ffmpeg -ss "$START_TIME" -i ./input_video.mp4 -vframes 1 -q:v 2 "./shot_frames/shot_${i}_first.jpg"
    
    MIDDLE_SECONDS=$(awk "BEGIN {print ($START_SECONDS + $END_SECONDS) / 2}")
    MIDDLE_HOURS=$(printf "%02d" $(awk "BEGIN {print int($MIDDLE_SECONDS / 3600)}"))
    MIDDLE_MINS=$(printf "%02d" $(awk "BEGIN {print int(($MIDDLE_SECONDS % 3600) / 60)}"))
    MIDDLE_SECS=$(printf "%06.3f" $(awk "BEGIN {print $MIDDLE_SECONDS % 60}"))
    MIDDLE_TIME="${MIDDLE_HOURS}:${MIDDLE_MINS}:${MIDDLE_SECS}"
    echo "Extracting middle frame at $MIDDLE_TIME..."
    ffmpeg -ss "$MIDDLE_TIME" -i ./input_video.mp4 -vframes 1 -q:v 2 "./shot_frames/shot_${i}_middle.jpg"
    
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