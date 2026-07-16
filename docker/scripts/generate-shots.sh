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

MAX_CONCURRENT=${MAX_CONCURRENT:-2}

MAX_ROUNDS=3
PENDING_FILE="/tmp/pending_indices.txt"
MISSING_FILE="/tmp/missing_indices.txt"

seq -s, 0 $((SHOT_COUNT - 1)) > "$PENDING_FILE"

report_progress() {
    local round=$1
    local processed=$2
    local total=$SHOT_COUNT
    local failed=$3
    local message="第${round}轮: 已完成 ${processed}/${total} 个分镜"
    if [ "$failed" -gt 0 ]; then
        message="${message}, ${failed}个失败待重试"
    fi
    echo "Reporting progress: $message"
    set +e
    curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"GENERATE_SHOTS\",\"processed_count\":$processed,\"total_count\":$total,\"failed_count\":$failed,\"message\":\"$message\"}" > /dev/null 2>&1
    set -e
}

for round in $(seq 1 $MAX_ROUNDS); do
    PENDING_INDICES=$(cat "$PENDING_FILE")
    if [ -z "$PENDING_INDICES" ]; then
        echo "All shots completed at round $((round - 1))"
        break
    fi

    echo "=== Round $round/$MAX_ROUNDS: Processing shots [$PENDING_INDICES] ==="

    export PENDING_INDICES
    export MAX_CONCURRENT

    python3 << PYTHON_SCRIPT
import json
import os
import sys
import time
import urllib.request
import urllib.error
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

ssl._create_default_https_context = ssl._create_unverified_context

task_id = os.environ.get('TASK_ID')
pending_indices_str = os.environ.get('PENDING_INDICES', '')

with open('./analysis_result.json', 'r') as f:
    result = json.load(f)

storyboards = result.get('storyboards', [])

if pending_indices_str:
    pending_indices = [int(x) for x in pending_indices_str.split(',') if x.strip()]
else:
    pending_indices = list(range(len(storyboards)))

def parse_time(time_str):
    parts = time_str.split(':')
    h = int(parts[0])
    m = int(parts[1])
    s_parts = parts[2].split('.')
    s = int(s_parts[0])
    ms = int(s_parts[1]) if len(s_parts) > 1 else 0
    return h * 3600 + m * 60 + s + ms / 1000

def generate_video(image_urls, prompt, shot_index, duration_seconds, output_fps):
    has_dialogue = "dialogue:" in prompt
    if has_dialogue:
        full_prompt = "在两个参考图像之间创建一个平滑的过渡场景，保持角色身份一致性，动作自然。严格按照提供的提示词和对话内容生成画面，角色可以有与对话匹配的口型动作，但不要在画面中生成任何文字字幕或额外的对话情节。" + prompt
    else:
        full_prompt = "在两个参考图像之间创建一个平滑的过渡场景，保持角色身份一致性，动作自然。严格按照提供的提示词生成画面，不要在画面中生成任何文字内容、对话字幕、口型动作或对话情节。" + prompt

    target_frames = int(duration_seconds * output_fps)
    if target_frames < 9:
        num_frames = 9
    else:
        n = (target_frames - 1) // 8
        num_frames = n * 8 + 1
        if num_frames < 9:
            num_frames = 9

    request_body = {
        'model': 'agnes-video-v2.0',
        'prompt': full_prompt,
        'extra_body': {
            'image': image_urls,
            'mode': 'keyframes'
        },
        'num_frames': num_frames,
        'frame_rate': output_fps,
        'width': 854,
        'height': 480,
        'seed': 42
    }

    print(f"  Shot {shot_index}: Duration: {duration_seconds:.3f}s, FPS: {output_fps}, Target frames: {num_frames}")

    max_retries = 3
    retry_delay = 10

    api_key = os.environ.get('AI_API_KEY', '').strip()
    ai_base_env = os.environ.get('AI_BASE_URL', 'https://apihub.agnes-ai.com').strip()
    parsed = urlparse(ai_base_env)
    base_url = f"{parsed.scheme}://{parsed.netloc}/v1/videos"

    if not base_url.startswith('http'):
        base_url = 'https://' + base_url

    json_data = json.dumps(request_body).encode('utf-8')

    headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + api_key
    }

    print(f"  Shot {shot_index}: Using URL: {base_url}")

    task_id_result = None
    video_id_result = None

    for attempt in range(max_retries):
        try:
            print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries}")
            req = urllib.request.Request(base_url, data=json_data, headers=headers, method='POST')
            resp = urllib.request.urlopen(req, timeout=300)
            resp_body = resp.read().decode('utf-8')
            resp_data = json.loads(resp_body)

            print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} - HTTP 200")
            print(f"  Shot {shot_index}: Response: {resp_body[:500]}...")

            task_id_result = resp_data.get('task_id') or resp_data.get('id') or resp_data.get('taskId')
            video_id_result = resp_data.get('video_id')

            if task_id_result:
                print(f"  Shot {shot_index}: Got task ID: {task_id_result}")
                if video_id_result:
                    print(f"  Shot {shot_index}: Got video ID: {video_id_result}")
                break

        except urllib.error.HTTPError as e:
            err_msg = f"HTTP Error {e.code}: {e.reason}"
            print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {err_msg}")
            if e.code == 503:
                backoff = retry_delay * (attempt + 2)
                print(f"  Shot {shot_index}: 503 queue full, waiting {backoff}s before retry...")
                time.sleep(backoff)
            elif e.code == 429:
                backoff = 30 * (attempt + 1)
                print(f"  Shot {shot_index}: 429 rate limited, waiting {backoff}s before retry...")
                time.sleep(backoff)
            elif attempt < max_retries - 1:
                time.sleep(retry_delay)
        except Exception as e:
            print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(retry_delay)

    if not task_id_result:
        print(f"  Shot {shot_index}: Failed to get task ID")
        return None

    print(f"  Shot {shot_index}: Polling for result...")
    max_polls = 90
    poll_interval = 10

    query_id = video_id_result if video_id_result else task_id_result

    parsed_base = urlparse(base_url)
    poll_base = f"{parsed_base.scheme}://{parsed_base.netloc}"

    for poll_attempt in range(max_polls):
        time.sleep(poll_interval)
        try:
            poll_url = f"{poll_base}/agnesapi?video_id={query_id}"
            req = urllib.request.Request(poll_url, headers={'Authorization': 'Bearer ' + api_key}, method='GET')
            resp = urllib.request.urlopen(req, timeout=30)
            resp_body = resp.read().decode('utf-8')
            resp_data = json.loads(resp_body)

            status = resp_data.get('status', '')
            progress = resp_data.get('progress', 0)
            print(f"  Shot {shot_index}: Poll {poll_attempt+1}/{max_polls} - Status: {status}, Progress: {progress}%")

            if status == 'completed':
                print(f"  Shot {shot_index}: Completed response: {resp_body[:2000]}")
                url = resp_data.get('url')
                if url:
                    print(f"  Shot {shot_index}: Got video URL: {url}")
                    return url
                print(f"  Shot {shot_index}: Task completed but no URL found")
                return None
            elif status in ['failed', 'error']:
                error_msg = resp_data.get('error', 'Unknown error')
                print(f"  Shot {shot_index}: Task failed: {error_msg}")
                return None

        except Exception as e:
            print(f"  Shot {shot_index}: Poll {poll_attempt+1} failed: {str(e)}")

    print(f"  Shot {shot_index}: Polling timeout")
    return None

def process_shot(shot_index):
    shot = storyboards[shot_index]
    start_time = shot.get('start_time', '00:00:00.000')
    end_time = shot.get('end_time', '00:00:00.000')
    start_sec = parse_time(start_time)
    end_sec = parse_time(end_time)
    duration = end_sec - start_sec

    print(f"Processing shot {shot_index}: {start_time} - {end_time} (duration={duration:.3f}s)")

    if shot_index == 0:
        first_frame_url = f"https://aivideobucket.ldragon.xyz/{task_id}/ai_shot_frames/shot_0_first.jpg"
    else:
        first_frame_url = f"https://aivideobucket.ldragon.xyz/{task_id}/ai_shot_frames/shot_{shot_index - 1}_last.jpg"
    last_frame_url = f"https://aivideobucket.ldragon.xyz/{task_id}/ai_shot_frames/shot_{shot_index}_last.jpg"

    print(f"First frame URL: {first_frame_url}")
    print(f"Last frame URL: {last_frame_url}")

    characters = shot.get('characters_present', [])
    speaker = shot.get('speaker', '')
    dialogue = shot.get('subtitles', '')
    scene_desc = shot.get('scene_description', '')
    positive_prompt = shot.get('positive_prompt', '')
    negative_prompt = shot.get('negative_prompt', '')

    main_prompt = f"{positive_prompt}, American animation style, anime style, high quality, {scene_desc}"
    if dialogue and dialogue != 'null':
        main_prompt += f", dialogue: {dialogue}"

    output_fps = int(os.environ.get('OUTPUT_FPS', 24))

    print(f"Shot {shot_index}: Duration: {duration:.3f}s")

    video_url = generate_video([first_frame_url, last_frame_url], main_prompt, shot_index, duration, output_fps)

    if video_url:
        print(f"Downloading generated video for shot {shot_index}...")
        try:
            urllib.request.urlretrieve(video_url, f'./generated_shots/shot_{shot_index}.mp4')
            print(f"Successfully generated shot {shot_index}")
            return (shot_index, True)
        except Exception as e:
            print(f"Error downloading video for shot {shot_index}: {str(e)}")
            return (shot_index, False)
    else:
        print(f"Error: Failed to generate shot {shot_index}")
        return (shot_index, False)

max_workers = int(os.environ.get('MAX_CONCURRENT', '2'))
print(f"Starting concurrent shot generation with {max_workers} workers...")

round_success = 0
round_failed = 0

with ThreadPoolExecutor(max_workers=max_workers) as executor:
    futures = {executor.submit(process_shot, idx): idx for idx in pending_indices}
    
    for future in as_completed(futures):
        shot_index, success = future.result()
        if success:
            round_success += 1
        else:
            round_failed += 1

missing = []
for i in range(len(storyboards)):
    filepath = f'./generated_shots/shot_{i}.mp4'
    if not (os.path.exists(filepath) and os.path.getsize(filepath) > 0):
        missing.append(str(i))

with open('/tmp/missing_indices.txt', 'w') as f:
    f.write(','.join(missing))

print(f"=== Round Complete ===")
print(f"Round success: {round_success}")
print(f"Round failed: {round_failed}")
print(f"Still missing: {','.join(missing) if missing else 'none'}")

PYTHON_SCRIPT

    echo "Uploading generated shots..."
    aws s3 sync "./generated_shots" "s3://$R2_BUCKET_NAME/${TASK_ID}/generated_shots" \
        --endpoint-url "$R2_ENDPOINT_URL"

    MISSING_INDICES=$(cat "$MISSING_FILE")

    COMPLETED=$((SHOT_COUNT - $(echo "$MISSING_INDICES" | tr -cd ',' | wc -c) - $([ -z "$MISSING_INDICES" ] && echo 0 || echo 1)))
    if [ -z "$MISSING_INDICES" ]; then
        COMPLETED=$SHOT_COUNT
        FAILED_COUNT=0
    else
        MISSING_COUNT=$(echo "$MISSING_INDICES" | tr ',' '\n' | grep -c .)
        COMPLETED=$((SHOT_COUNT - MISSING_COUNT))
        FAILED_COUNT=$MISSING_COUNT
    fi

    report_progress "$round" "$COMPLETED" "$FAILED_COUNT"

    if [ -z "$MISSING_INDICES" ]; then
        echo "=== All shots completed at round $round ==="
        break
    fi

    echo "Round $round: $FAILED_COUNT shots still missing, will retry..."
    echo "$MISSING_INDICES" > "$PENDING_FILE"

done

FINAL_MISSING=$(cat "$MISSING_FILE" 2>/dev/null || echo "")
if [ -n "$FINAL_MISSING" ]; then
    MISSING_COUNT=$(echo "$FINAL_MISSING" | tr ',' '\n' | grep -c .)
    echo "ERROR: $MISSING_COUNT shots failed after $MAX_ROUNDS rounds: [$FINAL_MISSING]"
    echo "Shots that could not be generated: $FINAL_MISSING"
    exit 1
fi

echo "Shot generation phase completed. All $SHOT_COUNT shots generated successfully."