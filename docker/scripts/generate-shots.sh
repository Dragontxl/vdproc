#!/bin/bash

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

process_shot() {
    local shot_index="$1"
    local work_dir="$2"
    local ai_accounts="$3"
    
    cd "$work_dir"
    
    START_TIME=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].start_time")
    END_TIME=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].end_time")
    CHARACTERS=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].characters")
    SPEAKER=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].speaker")
    DIALOGUE=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].dialogue")
    SCENE_DESC=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].scene_description")
    POSITIVE_PROMPT=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].positive_prompt")
    NEGATIVE_PROMPT=$(echo "$RESULT" | jq -r ".storyboards[$shot_index].negative_prompt")
    
    DURATION=$(python3 -c "
import sys
from datetime import datetime
start_str = sys.argv[1]
end_str = sys.argv[2]
start = datetime.strptime(start_str, '%H:%M:%S.%f')
end = datetime.strptime(end_str, '%H:%M:%S.%f')
duration = (end - start).total_seconds()
print('%.3f' % duration)
" "$START_TIME" "$END_TIME")
    
    FRAME_COUNT=$(echo "$DURATION * $OUTPUT_FPS" | bc | awk '{print int($1+0.5)}')
    
    echo "Processing shot $shot_index: duration=$DURATIONs, frames=$FRAME_COUNT"
    
    FIRST_FRAME_KEY="${TASK_ID}/ai_shot_frames/shot_${shot_index}_first.jpg"
    LAST_FRAME_KEY="${TASK_ID}/ai_shot_frames/shot_${shot_index}_last.jpg"
    
    echo "Downloading AI frames..."
    
    local has_first_frame=0
    local has_last_frame=0
    
    FIRST_FRAME_URL=$(aws s3 presign "s3://$R2_BUCKET_NAME/$FIRST_FRAME_KEY" --endpoint-url "$R2_ENDPOINT_URL" --expires-in 3600)
    LAST_FRAME_URL=$(aws s3 presign "s3://$R2_BUCKET_NAME/$LAST_FRAME_KEY" --endpoint-url "$R2_ENDPOINT_URL" --expires-in 3600)
    
    echo "Shot $shot_index: First frame URL: ${FIRST_FRAME_URL:0:80}..."
    echo "Shot $shot_index: Last frame URL: ${LAST_FRAME_URL:0:80}..."
    
    if [ -z "$FIRST_FRAME_URL" ]; then
        echo "Warning: First frame URL generation failed"
        has_first_frame=0
    else
        has_first_frame=1
    fi
    
    if [ -z "$LAST_FRAME_URL" ]; then
        echo "Warning: Last frame URL generation failed"
        has_last_frame=0
    else
        has_last_frame=1
    fi
    
    if [ $has_first_frame -eq 0 ] && [ $has_last_frame -eq 0 ]; then
        echo "Error: No AI frames found for shot $shot_index, skipping..."
        rm -f "./first_frame_${shot_index}.jpg" "./last_frame_${shot_index}.jpg"
        echo "$shot_index:SKIPPED" >> "./shot_results.txt"
        return 0
    fi
    
    if [ $has_first_frame -eq 0 ]; then
        FIRST_FRAME_URL="$LAST_FRAME_URL"
    fi
    
    if [ $has_last_frame -eq 0 ]; then
        LAST_FRAME_URL="$FIRST_FRAME_URL"
    fi
    
    MAIN_PROMPT="$POSITIVE_PROMPT, American animation style, anime style, high quality, $SCENE_DESC"
    if [ -n "$DIALOGUE" ]; then
        MAIN_PROMPT="$MAIN_PROMPT, dialogue: $DIALOGUE"
    fi
    
    local selected_key="$AI_API_KEY"
    local selected_url="${AI_BASE_URL:-https://apihub.agnes-ai.com}/v1/videos"
    
    if [ -n "$ai_accounts" ]; then
        local account_index=$((shot_index % $(echo "$ai_accounts" | jq -r '. | length')))
        selected_key=$(echo "$ai_accounts" | jq -r ".[$account_index].api_key_encrypted")
        selected_url=$(echo "$ai_accounts" | jq -r ".[$account_index].base_url")
        if [ "$selected_url" = "null" ] || [ -z "$selected_url" ]; then
            selected_url="https://apihub.agnes-ai.com/v1/videos"
        else
            selected_url=$(echo "$selected_url" | sed 's|/v1/images/generations|/v1/videos|')
        fi
    fi
    
    local lock_file="./locks/account_${shot_index}.lock"
    
    exec 200>"$lock_file"
    flock -x 200
    
    echo "Shot $shot_index: Using AI account index $account_index"
    
    sleep $((shot_index * 40))
    
    MAX_RETRIES=3
    RETRY_DELAY=10
    API_SUCCESS=0
    TASK_ID=""
    RESULT_URL=""
    
    for attempt in $(seq 1 $MAX_RETRIES); do
        local json_file="./request_${shot_index}_${attempt}.json"
        echo "  Shot $shot_index: Attempt $attempt/$MAX_RETRIES..."
        
        python3 -c "
import json

num_frames = $FRAME_COUNT
n = (num_frames - 1) // 8
adjusted_frames = 8 * n + 1
if adjusted_frames < 9:
    adjusted_frames = 9

data = {
    'model': 'agnes-video-v2.0',
    'prompt': '$MAIN_PROMPT',
    'num_frames': adjusted_frames,
    'frame_rate': $OUTPUT_FPS,
    'height': 480,
    'width': 854,
    'seed': 42,
    'extra_body': {
        'image': ['$FIRST_FRAME_URL', '$LAST_FRAME_URL'],
        'mode': 'keyframes'
    }
}

with open('$json_file', 'w') as f:
    json.dump(data, f)

print('Adjusted frames:', adjusted_frames)
print('Images:', ['$FIRST_FRAME_URL', '$LAST_FRAME_URL'])
"
        
        RESPONSE=$(curl -s -X POST \
            --connect-timeout 60 \
            --max-time 300 \
            -w "\n%{http_code}" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $selected_key" \
            -d "@$json_file" \
            "$selected_url")
        
        HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
        RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')
        
        echo "  Shot $shot_index: HTTP code: $HTTP_CODE"
        echo "  Shot $shot_index: API URL: $selected_url"
        if [ ${#RESPONSE_BODY} -gt 0 ]; then
            echo "  Shot $shot_index: Response (first 1000 chars): ${RESPONSE_BODY:0:1000}"
        fi
        
        if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            TASK_ID=$(echo "$RESPONSE_BODY" | jq -r '.task_id // .id // ""')
            if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "null" ]; then
                echo "  Shot $shot_index: Task ID: $TASK_ID"
                break
            fi
        fi
        
        if [ $attempt -lt $MAX_RETRIES ]; then
            sleep $RETRY_DELAY
        fi
    done
    
    if [ -z "$TASK_ID" ] || [ "$TASK_ID" = "null" ]; then
        flock -u 200
        echo "Error: Failed to create video task for shot $shot_index"
        rm -f "./first_frame_${shot_index}.jpg" "./last_frame_${shot_index}.jpg" "$lock_file" "./request_${shot_index}_*.json"
        echo "$shot_index:FAILED" >> "./shot_results.txt"
        return 1
    fi
    
    echo "  Shot $shot_index: Polling task status..."
    POLL_INTERVAL=30
    MAX_POLLS=60
    
    for poll in $(seq 1 $MAX_POLLS); do
        STATUS_RESPONSE=$(curl -s -X GET \
            --connect-timeout 30 \
            --max-time 60 \
            -w "\n%{http_code}" \
            -H "Authorization: Bearer $selected_key" \
            "$selected_url/$TASK_ID")
        
        STATUS_CODE=$(echo "$STATUS_RESPONSE" | tail -n1)
        STATUS_BODY=$(echo "$STATUS_RESPONSE" | sed '$d')
        
        if [ "$STATUS_CODE" -ge 200 ] && [ "$STATUS_CODE" -lt 300 ]; then
            STATUS=$(echo "$STATUS_BODY" | jq -r '.status // ""')
            PROGRESS=$(echo "$STATUS_BODY" | jq -r '.progress // ""')
            RESULT_URL=$(echo "$STATUS_BODY" | jq -r '.remixed_from_video_id // .url // .video_url // .output_url // .data.url // ""')
            
            echo "  Shot $shot_index: Status: $STATUS, Progress: $PROGRESS%"
            
            if [ "$STATUS" = "completed" ] || [ "$STATUS" = "SUCCESS" ]; then
                if [ -n "$RESULT_URL" ] && [ "$RESULT_URL" != "null" ]; then
                    API_SUCCESS=1
                    break
                fi
            elif [ "$STATUS" = "failed" ] || [ "$STATUS" = "FAILED" ]; then
                FAIL_REASON=$(echo "$STATUS_BODY" | jq -r '.fail_reason // .error // ""')
                echo "  Shot $shot_index: Task failed: $FAIL_REASON"
                break
            fi
        fi
        
        if [ $poll -lt $MAX_POLLS ]; then
            sleep $POLL_INTERVAL
        fi
    done
    
    flock -u 200
    
    if [ $API_SUCCESS -ne 1 ]; then
        echo "Error: Failed to generate shot $shot_index"
        rm -f "./first_frame_${shot_index}.jpg" "./last_frame_${shot_index}.jpg" "$lock_file" "./request_${shot_index}_*.json"
        echo "$shot_index:FAILED" >> "./shot_results.txt"
        return 1
    fi
    
    echo "  Shot $shot_index: Result URL: $RESULT_URL"
    if [ -z "$RESULT_URL" ]; then
        echo "Error: No result URL for shot $shot_index"
        rm -f "./first_frame_${shot_index}.jpg" "./last_frame_${shot_index}.jpg" "$lock_file" "./request_${shot_index}_*.json"
        echo "$shot_index:FAILED" >> "./shot_results.txt"
        return 1
    fi
    
    echo "Downloading generated video for shot $shot_index..."
    curl -s --connect-timeout 60 --max-time 120 -o "./generated_shots/shot_${shot_index}.mp4" "$RESULT_URL"
    
    if [ ! -f "./generated_shots/shot_${shot_index}.mp4" ] || [ ! -s "./generated_shots/shot_${shot_index}.mp4" ]; then
        echo "Error: Downloaded video is empty for shot $shot_index"
        rm -f "./first_frame_${shot_index}.jpg" "./last_frame_${shot_index}.jpg" "$lock_file" "./request_${shot_index}_*.json"
        echo "$shot_index:FAILED" >> "./shot_results.txt"
        return 1
    fi
    
    rm -f "./first_frame_${shot_index}.jpg" "./last_frame_${shot_index}.jpg" "$lock_file" "./request_${shot_index}_*.json"
    echo "$shot_index:SUCCESS" >> "./shot_results.txt"
    echo "Successfully generated shot $shot_index"
    
    return 0
}

export -f process_shot
export RESULT
export TASK_ID
export OUTPUT_FPS
export R2_BUCKET_NAME
export R2_ENDPOINT_URL
export AI_API_KEY
export AI_BASE_URL

rm -f "./shot_results.txt"

echo "$RESULT" | jq -r '.storyboards | to_entries[] | .key' | \
    xargs -P "$ACCOUNT_COUNT" -I {} bash -c 'process_shot "$@"' _ {} "$WORK_DIR" "$AI_ACCOUNTS" || true

SUCCESS_COUNT=$(grep -c ':SUCCESS' "./shot_results.txt" 2>/dev/null)
SUCCESS_COUNT=${SUCCESS_COUNT:-0}
SUCCESS_COUNT=$(echo "$SUCCESS_COUNT" | tr -d '\n')

FAILED_COUNT=$(grep -c ':FAILED' "./shot_results.txt" 2>/dev/null)
FAILED_COUNT=${FAILED_COUNT:-0}
FAILED_COUNT=$(echo "$FAILED_COUNT" | tr -d '\n')

echo "=== Shot Generation Complete ==="
echo "Total: $SHOT_COUNT"
echo "Success: $SUCCESS_COUNT"
echo "Failed: $FAILED_COUNT"

if [ $SUCCESS_COUNT -eq 0 ]; then
    echo "Error: No shots generated successfully"
    exit 1
fi

if [ "$FAILED_COUNT" -gt 0 ]; then
    echo "Warning: Some shots failed to generate"
fi

echo "Uploading generated shots..."
aws s3 sync "./generated_shots" "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Shot generation phase completed."