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
SHOT_COUNT=$(echo "$RESULT" | jq -r '.storyboards | length')

echo "Found $SHOT_COUNT shots to generate"

mkdir -p ./generated_shots
mkdir -p ./locks

ACCOUNT_COUNT=1
if [ -n "$AI_ACCOUNTS" ]; then
    ACCOUNT_COUNT=$(echo "$AI_ACCOUNTS" | jq -r '. | length')
fi

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Concurrency: $ACCOUNT_COUNT"

parse_time() {
    local t="$1"
    local h=$(echo "$t" | cut -d: -f1)
    local m=$(echo "$t" | cut -d: -f2)
    local s=$(echo "$t" | cut -d: -f3 | cut -d. -f1)
    local ms=$(echo "$t" | cut -d. -f2)
    awk "BEGIN {printf \"%.3f\", $h*3600 + $m*60 + $s + $ms/1000}"
}

process_shot() {
    local shot_index="$1"
    local work_dir="$2"
    local ai_accounts="$3"
    
    cd "$work_dir"
    
    START_TIME=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].start_time")
    END_TIME=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].end_time")
    CHARACTERS=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].characters_present")
    SPEAKER=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].speaker")
    DIALOGUE=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].subtitles")
    SCENE_DESC=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].scene_description")
    POSITIVE_PROMPT=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].positive_prompt")
    NEGATIVE_PROMPT=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].negative_prompt")
    
    START_SEC=$(parse_time "$START_TIME")
    END_SEC=$(parse_time "$END_TIME")
    DURATION=$(awk "BEGIN {printf \"%.3f\", $END_SEC - $START_SEC}")
    
    echo "Processing shot $shot_index: $START_TIME - $END_TIME (duration=$DURATIONs)"
    
    FIRST_FRAME_KEY="${TASK_ID}/ai_shot_frames/shot_${shot_index}_first.jpg"
    LAST_FRAME_KEY="${TASK_ID}/ai_shot_frames/shot_${shot_index}_last.jpg"
    
    FIRST_FRAME_URL="https://aivideobucket.ldragon.xyz/${FIRST_FRAME_KEY}"
    LAST_FRAME_URL="https://aivideobucket.ldragon.xyz/${LAST_FRAME_KEY}"
    
    echo "First frame URL: $FIRST_FRAME_URL"
    echo "Last frame URL: $LAST_FRAME_URL"
    
    MAIN_PROMPT="$POSITIVE_PROMPT, American animation style, anime style, high quality, $SCENE_DESC"
    if [ -n "$DIALOGUE" ] && [ "$DIALOGUE" != "null" ]; then
        MAIN_PROMPT="$MAIN_PROMPT, dialogue: $DIALOGUE"
    fi
    
    local selected_key="$AI_API_KEY"
    local selected_url="${AI_BASE_URL:-https://apihub.agnes-ai.com/v1/videos}"
    local selected_model="agnes-video"
    
    if [ -n "$ai_accounts" ]; then
        local account_index=$((shot_index % $(echo "$ai_accounts" | jq -r '. | length')))
        selected_key=$(echo "$ai_accounts" | jq -r ".[$account_index].api_key_encrypted")
        selected_url=$(echo "$ai_accounts" | jq -r ".[$account_index].base_url")
        selected_model=$(echo "$ai_accounts" | jq -r ".[$account_index].model_name")
        if [ "$selected_url" = "null" ] || [ -z "$selected_url" ]; then
            selected_url="https://apihub.agnes-ai.com/v1/videos/generations"
        fi
        if [ "$selected_model" = "null" ] || [ -z "$selected_model" ]; then
            selected_model="agnes-video"
        fi
    fi
    
    echo "Shot $shot_index: Using model $selected_model at $selected_url"
    
    local lock_file="./locks/account_${shot_index}.lock"
    
    exec 200>"$lock_file"
    flock -x 200
    
    echo "Shot $shot_index: Using AI account index $account_index"
    
    MAX_RETRIES=3
    RETRY_DELAY=10
    API_SUCCESS=0
    RESPONSE=""
    
    for attempt in $(seq 1 $MAX_RETRIES); do
        echo "  Shot $shot_index: Attempt $attempt/$MAX_RETRIES..."
        
        RESPONSE=$(curl -s -X POST \
            --connect-timeout 60 \
            --max-time 300 \
            -w "\n%{http_code}" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $selected_key" \
            -d "{
                \"model\": \"$selected_model\",
                \"prompt\": \"在两个参考图像之间创建一个平滑的过渡场景，保持角色身份一致性，动作自然。$MAIN_PROMPT\",
                \"extra_body\": {
                    \"image\": [\"$FIRST_FRAME_URL\", \"$LAST_FRAME_URL\"],
                    \"mode\": \"keyframes\"
                },
                \"num_frames\": 361,
                \"frame_rate\": 24,
                \"width\": 854,
                \"height\": 480,
                \"seed\": 42
            }" \
            "$selected_url")
        
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
    
    flock -u 200
    
    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: Failed to generate shot $shot_index"
        rm -f "$lock_file"
        echo "$shot_index:FAILED" >> "./shot_results.txt"
        return 1
    fi
    
    RESULT_URL=$(echo "$RESPONSE" | jq -r '.data[0].url // ""')
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for shot $shot_index"
        rm -f "$lock_file"
        echo "$shot_index:FAILED" >> "./shot_results.txt"
        return 1
    fi
    
    echo "Downloading generated video for shot $shot_index..."
    curl -s --connect-timeout 60 --max-time 120 -o "./generated_shots/shot_${shot_index}.mp4" "$RESULT_URL"
    
    if [ ! -f "./generated_shots/shot_${shot_index}.mp4" ] || [ ! -s "./generated_shots/shot_${shot_index}.mp4" ]; then
        echo "Error: Downloaded video is empty for shot $shot_index"
        rm -f "$lock_file"
        echo "$shot_index:FAILED" >> "./shot_results.txt"
        return 1
    fi
    
    rm -f "$lock_file"
    echo "$shot_index:SUCCESS" >> "./shot_results.txt"
    echo "Successfully generated shot $shot_index"
    
    return 0
}

export -f process_shot
export -f parse_time
export RESULT
export TASK_ID
export OUTPUT_FPS
export R2_BUCKET_NAME
export R2_ENDPOINT_URL
export AI_API_KEY
export AI_BASE_URL

rm -f "./shot_results.txt"

echo "$RESULT" | jq -r '.storyboards | to_entries[] | .key' | \
    xargs -P "$ACCOUNT_COUNT" -I {} bash -c 'process_shot "$@"' _ {} "$WORK_DIR" "$AI_ACCOUNTS"

SUCCESS_COUNT=$(grep -c ':SUCCESS' "./shot_results.txt" 2>/dev/null || echo 0)
FAILED_COUNT=$(grep -c ':FAILED' "./shot_results.txt" 2>/dev/null || echo 0)

echo "=== Shot Generation Complete ==="
echo "Total: $SHOT_COUNT"
echo "Success: $SUCCESS_COUNT"
echo "Failed: $FAILED_COUNT"

if [ "$FAILED_COUNT" -gt 0 ]; then
    echo "Warning: Some shots failed to generate"
fi

echo "Uploading generated shots..."
aws s3 sync "./generated_shots" "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Shot generation phase completed."
