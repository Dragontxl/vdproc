#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 7: Shot Generation ==="
echo "Task ID: $TASK_ID"
echo "AI Account ID: $AI_ACCOUNT_ID"
echo "Output FPS: $OUTPUT_FPS"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/generate-shots.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

if [ -z "$AI_API_KEY" ]; then
    echo "Error: AI_API_KEY not set"
    exit 1
fi

echo "Downloading analysis result..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" "./analysis_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL"

RESULT=$(cat ./analysis_result.json)
SHOT_COUNT=$(echo "$RESULT" | jq -r '.shots | length')

echo "Found $SHOT_COUNT shots to generate"

mkdir -p ./generated_shots

SUCCESS_COUNT=0
FAILED_COUNT=0

for i in $(seq 0 $((SHOT_COUNT - 1))); do
    START_TIME=$(echo "$RESULT" | jq -r ".shots[$i].start_time")
    END_TIME=$(echo "$RESULT" | jq -r ".shots[$i].end_time")
    DURATION=$(echo "$RESULT" | jq -r ".shots[$i].duration")
    CHARACTERS=$(echo "$RESULT" | jq -r ".shots[$i].characters")
    SPEAKER=$(echo "$RESULT" | jq -r ".shots[$i].speaker")
    DIALOGUE=$(echo "$RESULT" | jq -r ".shots[$i].dialogue")
    SCENE_DESC=$(echo "$RESULT" | jq -r ".shots[$i].scene_description")
    POSITIVE_PROMPT=$(echo "$RESULT" | jq -r ".shots[$i].positive_prompt")
    NEGATIVE_PROMPT=$(echo "$RESULT" | jq -r ".shots[$i].negative_prompt")
    
    FRAME_COUNT=$(echo "$DURATION * $OUTPUT_FPS" | bc | awk '{print int($1+0.5)}')
    
    echo "Processing shot $i: duration=$DURATIONs, frames=$FRAME_COUNT"
    
    FIRST_FRAME_KEY="${TASK_ID}/ai_shot_frames/shot_${i}_first.jpg"
    LAST_FRAME_KEY="${TASK_ID}/ai_shot_frames/shot_${i}_last.jpg"
    
    echo "Downloading AI frames..."
    aws s3 cp "s3://$R2_BUCKET_NAME/$FIRST_FRAME_KEY" "./first_frame.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL"
    aws s3 cp "s3://$R2_BUCKET_NAME/$LAST_FRAME_KEY" "./last_frame.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL"
    
    FIRST_FRAME_BASE64=$(base64 -w0 ./first_frame.jpg)
    LAST_FRAME_BASE64=$(base64 -w0 ./last_frame.jpg)
    
    MAIN_PROMPT="$POSITIVE_PROMPT, American animation style, anime style, high quality, $SCENE_DESC"
    if [ -n "$DIALOGUE" ]; then
        MAIN_PROMPT="$MAIN_PROMPT, dialogue: $DIALOGUE"
    fi
    
    MAX_RETRIES=3
    RETRY_DELAY=10
    API_SUCCESS=0
    
    for attempt in $(seq 1 $MAX_RETRIES); do
        echo "  Attempt $attempt/$MAX_RETRIES..."
        
        RESPONSE=$(curl -s -X POST \
            --connect-timeout 60 \
            --max-time 300 \
            -w "\n%{http_code}" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $AI_API_KEY" \
            -d "{
                \"model\": \"agnes-video\",
                \"prompt\": \"$MAIN_PROMPT\",
                \"duration\": $DURATION,
                \"extra_body\": {
                    \"image\": [\"data:image/jpeg;base64,$FIRST_FRAME_BASE64\", \"data:image/jpeg;base64,$LAST_FRAME_BASE64\"],
                    \"response_format\": \"url\"
                }
            }" \
            "${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/videos/generations")
        
        HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
        RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')
        
        if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            API_SUCCESS=1
            RESPONSE="$RESPONSE_BODY"
            break
        fi
        
        if [ $attempt -lt $MAX_RETRIES ]; then
            sleep $RETRY_DELAY
        fi
    done
    
    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: Failed to generate shot $i"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        rm -f ./first_frame.jpg ./last_frame.jpg
        continue
    fi
    
    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        rm -f ./first_frame.jpg ./last_frame.jpg
        continue
    fi
    
    echo "Downloading generated video..."
    curl -s --connect-timeout 60 --max-time 120 -o "./generated_shots/shot_${i}.mp4" "$RESULT_URL"
    
    if [ ! -f "./generated_shots/shot_${i}.mp4" ] || [ ! -s "./generated_shots/shot_${i}.mp4" ]; then
        echo "Error: Downloaded video is empty"
        FAILED_COUNT=$((FAILED_COUNT + 1))
        rm -f ./first_frame.jpg ./last_frame.jpg
        continue
    fi
    
    echo "Uploading to R2..."
    aws s3 cp "./generated_shots/shot_${i}.mp4" \
        "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots/shot_${i}.mp4" \
        --endpoint-url "$R2_ENDPOINT_URL" \
        --content-type video/mp4
    
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    echo "Progress: $SUCCESS_COUNT/$SHOT_COUNT"
    
    rm -f ./first_frame.jpg ./last_frame.jpg
    sleep ${COOLDOWN_SECONDS:-2}
done

echo "Phase 7 completed: $SUCCESS_COUNT generated, $FAILED_COUNT failed"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "successCount": $SUCCESS_COUNT,
    "failedCount": $FAILED_COUNT,
    "path": "${TASK_ID}/generated_shots/"
}
EOF