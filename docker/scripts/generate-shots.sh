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

ACCOUNT_COUNT=1
if [ -n "$AI_ACCOUNTS" ]; then
    ACCOUNT_COUNT=$(echo "$AI_ACCOUNTS" | jq -r '. | length')
fi

MAX_CONCURRENT=${MAX_CONCURRENT:-2}
EFFECTIVE_CONCURRENCY=$(( ACCOUNT_COUNT < MAX_CONCURRENT ? ACCOUNT_COUNT : MAX_CONCURRENT ))

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Max concurrent (from GitHub accounts): $MAX_CONCURRENT"
echo "Effective concurrency: $EFFECTIVE_CONCURRENCY"

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
    export EFFECTIVE_CONCURRENCY

    python3 << PYTHON_SCRIPT
import json
import os
import sys
import time
import urllib.request
import urllib.error
import ssl
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

ssl._create_default_https_context = ssl._create_unverified_context

task_id = os.environ.get('TASK_ID')
ai_accounts_json = os.environ.get('AI_ACCOUNTS', '[]')
pending_indices_str = os.environ.get('PENDING_INDICES', '')

with open('./analysis_result.json', 'r') as f:
    result = json.load(f)

storyboards = result.get('storyboards', [])
accounts = json.loads(ai_accounts_json)

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

bad_accounts = set()
bad_accounts_lock = threading.Lock()

if accounts:
    account_locks = [threading.Lock() for _ in range(len(accounts))]
else:
    account_locks = [threading.Lock()]

def generate_video(accounts_list, start_index, image_urls, prompt, shot_index, duration_seconds, output_fps):
    full_prompt = "在两个参考图像之间创建一个平滑的过渡场景，保持角色身份一致性，动作自然。" + prompt

    num_frames = int(duration_seconds * output_fps)
    if num_frames % 8 != 1:
        num_frames = ((num_frames // 8) + 1) * 8 + 1

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

    max_retries = 3
    retry_delay = 10

    candidates = []
    if accounts_list:
        for offset in range(len(accounts_list)):
            idx = (start_index + offset) % len(accounts_list)
            with bad_accounts_lock:
                if idx not in bad_accounts:
                    candidates.append(idx)
    if not candidates:
        for offset in range(len(accounts_list) if accounts_list else 1):
            candidates.append(offset)

    for cand_idx in candidates:
        lock = account_locks[cand_idx] if cand_idx < len(account_locks) else account_locks[0]
        with lock:
            if accounts_list:
                account = accounts_list[cand_idx]
                api_key = account.get('api_key_encrypted', '').strip()
                base_url = account.get('base_url', 'https://apihub.agnes-ai.com/v1/videos').strip()
                model_name = account.get('model_name', 'agnes-video-v2.0').strip()
            else:
                api_key = os.environ.get('AI_API_KEY', '').strip()
                base_url = os.environ.get('AI_BASE_URL', 'https://apihub.agnes-ai.com/v1/videos').strip()
                model_name = 'agnes-video-v2.0'

            if not base_url.startswith('http'):
                base_url = 'https://' + base_url

            request_body['model'] = model_name
            json_data = json.dumps(request_body).encode('utf-8')

            headers = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + api_key
            }

            db_account_id = account.get('id') if accounts_list else 'default'
            print(f"  Shot {shot_index}: Using AI account index {cand_idx} (db_id={db_account_id}, model={model_name}, URL={base_url})")

            task_id_result = None
            video_id_result = None
            auth_failed = False

            for attempt in range(max_retries):
                try:
                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} - URL: {base_url}")
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

                    url = resp_data.get('remixed_from_video_id') or resp_data.get('video_url') or resp_data.get('output_url') or resp_data.get('url')
                    if url:
                        print(f"  Shot {shot_index}: Got direct URL: {url}")
                        return url

                except urllib.error.HTTPError as e:
                    err_msg = f"HTTP Error {e.code}: {e.reason}"
                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {err_msg}")
                    if e.code == 401:
                        auth_failed = True
                        break
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                except Exception as e:
                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {str(e)}")
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)

            if auth_failed:
                account_alias = accounts[cand_idx].get('account_alias', 'Unknown')
                print(f"  Shot {shot_index}: Account [{account_alias}] (index {cand_idx}, db_id={db_account_id}) returned 401, marking as bad - please check this account")
                with bad_accounts_lock:
                    bad_accounts.add(cand_idx)
                continue

            if not task_id_result:
                print(f"  Shot {shot_index}: Failed to get task ID with account {cand_idx}, trying next account")
                continue

            print(f"  Shot {shot_index}: Polling for result...")
            max_polls = 90
            poll_interval = 10

            query_id = video_id_result if video_id_result else task_id_result

            for poll_attempt in range(max_polls):
                time.sleep(poll_interval)
                try:
                    poll_url = f"https://apihub.agnes-ai.com/agnesapi?video_id={query_id}"
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

    print(f"  Shot {shot_index}: All accounts exhausted")
    return None

def process_shot(shot_index):
    shot = storyboards[shot_index]
    start_time = shot.get('start_time', '00:00:00.000')
    end_time = shot.get('end_time', '00:00:00.000')
    start_sec = parse_time(start_time)
    end_sec = parse_time(end_time)
    duration = end_sec - start_sec

    print(f"Processing shot {shot_index}: {start_time} - {end_time} (duration={duration:.3f}s)")

    first_frame_url = f"https://aivideobucket.ldragon.xyz/{task_id}/ai_shot_frames/shot_{shot_index}_first.jpg"
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

    account_index = shot_index % len(accounts) if accounts else 0
    output_fps = int(os.environ.get('OUTPUT_FPS', 24))

    print(f"Shot {shot_index}: Starting with AI account index {account_index}")
    print(f"Shot {shot_index}: Duration: {duration:.3f}s, Target frames: {int(duration * output_fps)}")

    video_url = generate_video(accounts if accounts else None, account_index, [first_frame_url, last_frame_url], main_prompt, shot_index, duration, output_fps)

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

effective_concurrency = int(os.environ.get('EFFECTIVE_CONCURRENCY', '2'))
max_workers = min(len(accounts) if accounts else 1, effective_concurrency)
print(f"Starting concurrent shot generation with {max_workers} workers (effective concurrency: {effective_concurrency}, AI accounts: {len(accounts) if accounts else 1})...")

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
