#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 6: Video Composition ==="
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
mkdir -p ./mixed

has_audio() {
    ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$1" 2>/dev/null | grep -q .
}

media_duration() {
    ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null
}

# 统一音轨为 aac 48k 立体声，视频直接 copy，保证后续 concat -c copy 可用；无音轨则补静音
normalize_clip() {
    local in="$1"
    local out="$2"
    if has_audio "$in"; then
        ffmpeg -y -v error -i "$in" \
            -map 0:v:0 -map 0:a:0 \
            -c:v copy -c:a aac -ar 48000 -ac 2 -shortest "$out"
    else
        ffmpeg -y -v error -i "$in" -f lavfi -i anullsrc=r=48000:cl=stereo \
            -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -ar 48000 -ac 2 -shortest "$out"
    fi
}

echo "Downloading and preparing generated shots..."
for i in $(seq 0 $((SHOT_COUNT - 1))); do
    echo "Processing shot $i..."
    aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots/shot_${i}.mp4" "./downloaded_shots/shot_${i}.mp4" \
        --endpoint-url "$R2_ENDPOINT_URL" || true

    GEN="./downloaded_shots/shot_${i}.mp4"
    if [ ! -f "$GEN" ] || [ ! -s "$GEN" ]; then
        echo "Warning: Shot $i generated video missing or empty, will skip"
        continue
    fi

    OUT="./mixed/shot_${i}.mp4"
    USE_SOURCE=$(echo "$RESULT" | jq -r ".storyboards[$i].use_source_audio // false")

    if [ "$USE_SOURCE" = "true" ]; then
        echo "  Shot $i: use_source_audio=true, overlaying model voice-over audio"
        aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/voice-over/shot_${i}.mp4" "./orig_${i}.mp4" \
            --endpoint-url "$R2_ENDPOINT_URL" || true
        ORIG="./orig_${i}.mp4"
        GDUR=$(media_duration "$GEN" || true)
        if [ -f "$ORIG" ] && [ -s "$ORIG" ] && has_audio "$ORIG"; then
            if [ -n "$GDUR" ]; then
                ffmpeg -y -v error -i "$GEN" -i "$ORIG" \
                    -map 0:v:0 -map 1:a:0 \
                    -c:v copy -c:a aac -ar 48000 -ac 2 -t "$GDUR" "$OUT"
            else
                ffmpeg -y -v error -i "$GEN" -i "$ORIG" \
                    -map 0:v:0 -map 1:a:0 \
                    -c:v copy -c:a aac -ar 48000 -ac 2 -shortest "$OUT"
            fi
        else
            echo "  Warning: shot $i voice-over audio unavailable, keeping generated audio"
            normalize_clip "$GEN" "$OUT"
        fi
        rm -f "$ORIG"
    else
        normalize_clip "$GEN" "$OUT"
    fi
done

echo "Creating concat list..."
ls -1 ./mixed/*.mp4 2>/dev/null | sort -V | sed 's/^/file '\''/' | sed 's/$/'\''/' > ./file_list.txt

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

echo "Phase 6 completed successfully"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "videoPath": "${TASK_ID}/output/video.mp4",
    "videoUrl": "$FINAL_URL",
    "shotCount": $SHOT_COUNT
}
EOF