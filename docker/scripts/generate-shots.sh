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

ACCOUNT_COUNT=0
if [ -n "$AI_ACCOUNTS" ]; then
    AI_ACCOUNTS=$(echo "$AI_ACCOUNTS" | jq -c '[.[] | select(.api_type == "video")]')
    ACCOUNT_COUNT=$(echo "$AI_ACCOUNTS" | jq -r '. | length')
fi

if [ "$ACCOUNT_COUNT" -eq 0 ]; then
    echo "Error: No video-type AI accounts available"
    exit 1
fi

MAX_CONCURRENT=${MAX_CONCURRENT:-2}
EFFECTIVE_CONCURRENCY=$(( ACCOUNT_COUNT < MAX_CONCURRENT ? ACCOUNT_COUNT : MAX_CONCURRENT ))

echo "Available AI accounts: $ACCOUNT_COUNT"
echo "Max concurrent (from GitHub accounts): $MAX_CONCURRENT"
echo "Effective concurrency: $EFFECTIVE_CONCURRENCY"

notify_subtask() {
    local action="$1"
    local shot_index="$2"
    local status="$3"
    local output_path="$4"
    local error_msg="$5"
    
    if [ -z "$CALLBACK_URL" ]; then
        return
    fi
    
    local r2_public_url="${R2_PUBLIC_URL:-https://aivideobucket.ldragon.xyz}"
    local first_frame_url="${r2_public_url}/${TASK_ID}/ai_shot_frames/shot_${shot_index}_first.jpg"
    if [ "$shot_index" -gt 0 ]; then
        first_frame_url="${r2_public_url}/${TASK_ID}/ai_shot_frames/shot_$((shot_index - 1))_last.jpg"
    fi
    local last_frame_url="${r2_public_url}/${TASK_ID}/ai_shot_frames/shot_${shot_index}_last.jpg"
    
    local payload="{\"task_id\":\"$TASK_ID\",\"phase\":\"GENERATE_SHOTS\",\"subtask_index\":$shot_index"
    
    if [ "$action" = "create" ]; then
        payload="$payload,\"subtask_type\":\"shot\",\"input_path\":\"$first_frame_url|$last_frame_url\",\"metadata\":\"{\\\"shot_index\\\":$shot_index}\"}"
        curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/subtask/create" \
            -H "Content-Type: application/json" \
            -H "X-Callback-Signature: $CALLBACK_SECRET" \
            -d "$payload" > /dev/null 2>&1 || true
    elif [ "$action" = "update" ]; then
        payload="$payload,\"status\":\"$status\""
        if [ -n "$output_path" ]; then
            payload="$payload,\"output_path\":\"$output_path\""
        fi
        if [ -n "$error_msg" ]; then
            payload="$payload,\"error_msg\":\"$(echo "$error_msg" | sed 's/"/\\"/g')\""
        fi
        payload="$payload}"
        curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/subtask/update" \
            -H "Content-Type: application/json" \
            -H "X-Callback-Signature: $CALLBACK_SECRET" \
            -d "$payload" > /dev/null 2>&1 || true
    fi
}

export -f notify_subtask

MAX_ROUNDS=3
if [ -n "$SUBTASK_INDEX" ]; then
    MAX_ROUNDS=1
fi
PENDING_FILE="/tmp/pending_indices.txt"
MISSING_FILE="/tmp/missing_indices.txt"

if [ -n "$SUBTASK_INDEX" ]; then
    echo "Running as subtask: Shot index $SUBTASK_INDEX"
    echo "$SUBTASK_INDEX" > "$PENDING_FILE"
else
    seq -s, 0 $((SHOT_COUNT - 1)) > "$PENDING_FILE"
fi

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
from urllib.parse import urlparse

ssl._create_default_https_context = ssl._create_unverified_context

task_id = os.environ.get('TASK_ID')
ai_accounts_json = os.environ.get('AI_ACCOUNTS', '').strip() or '[]'
pending_indices_str = os.environ.get('PENDING_INDICES', '')

with open('./analysis_result.json', 'r') as f:
    result = json.load(f)

storyboards = result.get('storyboards', [])
accounts = json.loads(ai_accounts_json)

video_accounts = [acc for acc in accounts if acc.get('api_type', 'video') == 'video']
if video_accounts:
    accounts = video_accounts
    print(f"  Filtered to {len(accounts)} video-type AI accounts")

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
    custom_prompt = os.environ.get('CUSTOM_PROMPT', '').strip()
    if custom_prompt:
        full_prompt = custom_prompt
        print(f"  Shot {shot_index}: Using custom prompt")
    else:
        full_prompt = prompt

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
        'image': image_urls,
        'image_list': image_urls,
        'mode': 'keyframes',
        'negative_prompt': 'pc game, console game, video game, cartoon, childish, ugly, subtitles, watermark, worst quality, blurry, jittery, distorted, inconsistent appearance, text, watermarks, logos, readable signage, overlay, titles, has blurbox, has subtitles, artifacts around text, unreadable text, incorrect lettering, incorrect slogan',
        'num_frames': num_frames,
        'frame_rate': output_fps,
        'width': 832,
        'height': 448,
        'seed': 42,
        'global_prompt': '',
        'local_prompts': '',
        'max_length': 256,
        'background_image': None
    }

    print(f"  Shot {shot_index}: Duration: {duration_seconds:.3f}s, FPS: {output_fps}, Target frames: {num_frames}")
    print(f"  Shot {shot_index}: Request body num_frames: {num_frames}, frame_rate: {output_fps}, expected duration: {num_frames/output_fps:.2f}s")

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
                base_url = account.get('base_url', '').strip()
                model_name = account.get('model_name', 'agnes-video-v2.0').strip()
                account_alias = account.get('account_alias', '')
                
                if not base_url:
                    base_url = 'https://apihub.agnes-ai.com/v1/videos'
                elif '/v1/videos' not in base_url:
                    parsed = urlparse(base_url)
                    base_url = f"{parsed.scheme}://{parsed.netloc}/v1/videos"
                
                print(f"  Shot {shot_index}: Using AI account index {cand_idx} (alias: {account_alias})")
            else:
                print(f"  Shot {shot_index}: Error: No AI accounts available")
                return None

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

                except urllib.error.HTTPError as e:
                    err_msg = f"HTTP Error {e.code}: {e.reason}"
                    print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {err_msg}")
                    if e.code == 401:
                        auth_failed = True
                        break
                    if e.code == 503:
                        backoff = retry_delay * (attempt + 2)
                        print(f"  Shot {shot_index}: 503 queue full, waiting {backoff}s before retry...")
                        time.sleep(backoff)
                    elif e.code == 429:
                        # 限流，使用指数退避（Agnes限制2请求/分钟）
                        backoff = 30 * (attempt + 1)
                        print(f"  Shot {shot_index}: 429 rate limited, waiting {backoff}s before retry...")
                        time.sleep(backoff)
                    elif attempt < max_retries - 1:
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
                
                import subprocess
                callback_url = os.environ.get('CALLBACK_URL', '')
                callback_secret = os.environ.get('CALLBACK_SECRET', '')
                task_id_env = os.environ.get('TASK_ID', '')
                if callback_url and task_id_env:
                    try:
                        subprocess.run([
                            'curl', '-s', '--connect-timeout', '10', '--max-time', '30',
                            '-X', 'POST', f"{callback_url}/account-error",
                            '-H', 'Content-Type: application/json',
                            '-H', f"X-Callback-Signature: {callback_secret}",
                            '-d', f'{{"task_id":"{task_id_env}","account_id":{db_account_id},"error_type":"invalid_credentials","message":"Account returned 401"}}'
                        ], check=False, capture_output=True)
                    except Exception as e:
                        print(f"  Shot {shot_index}: Failed to send account error callback: {str(e)}")
                
                continue

            if not task_id_result:
                print(f"  Shot {shot_index}: Failed to get task ID with account {cand_idx}, trying next account")
                continue

            print(f"  Shot {shot_index}: Polling for result...")
            max_polls = 90
            poll_interval = 10

            query_id = video_id_result if video_id_result else task_id_result

            # 根据官方文档，轮询URL格式: {domain}/agnesapi?video_id={video_id}
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

    print(f"  Shot {shot_index}: All accounts exhausted")
    return None

def notify_subtask_python(action, shot_index, status='', output_path='', error_msg=''):
    import subprocess
    callback_url = os.environ.get('CALLBACK_URL', '')
    callback_secret = os.environ.get('CALLBACK_SECRET', '')
    task_id_env = os.environ.get('TASK_ID', '')
    
    if not callback_url:
        return
    
    cmd = ['bash', '-c', f'notify_subtask "{action}" "{shot_index}" "{status}" "{output_path}" "{error_msg}"']
    try:
        subprocess.run(cmd, check=False, capture_output=True)
    except Exception as e:
        print(f"  Shot {shot_index}: Failed to notify subtask: {str(e)}")

def process_shot(shot_index):
    shot = storyboards[shot_index]
    start_time = shot.get('start_time', '00:00:00.000')
    end_time = shot.get('end_time', '00:00:00.000')
    start_sec = parse_time(start_time)
    end_sec = parse_time(end_time)
    duration = end_sec - start_sec

    print(f"Processing shot {shot_index}: {start_time} - {end_time} (duration={duration:.3f}s)")
    notify_subtask_python("create", shot_index)

    r2_public_url = os.environ.get('R2_PUBLIC_URL', 'https://aivideobucket.ldragon.xyz')
    
    if shot_index == 0:
        first_frame_url = f"{r2_public_url}/{task_id}/ai_shot_frames/shot_0_first.jpg"
    else:
        first_frame_url = f"{r2_public_url}/{task_id}/ai_shot_frames/shot_{shot_index - 1}_last.jpg"
    middle_frame_url = f"{r2_public_url}/{task_id}/ai_shot_frames/shot_{shot_index}_middle.jpg"
    last_frame_url = f"{r2_public_url}/{task_id}/ai_shot_frames/shot_{shot_index}_last.jpg"

    print(f"First frame URL: {first_frame_url}")
    print(f"Middle frame URL: {middle_frame_url}")
    print(f"Last frame URL: {last_frame_url}")

    characters_present = shot.get('characters_present', [])
    dialogues = shot.get('dialogues', [])
    scene_desc = shot.get('scene_description', '')
    camera_movement = shot.get('camera_movement', '')
    positive_prompt = shot.get('positive_prompt', '')
    negative_prompt = shot.get('negative_prompt', '')

    video_summary = result.get('video_summary', '')

    global_characters = result.get('characters', [])
    char_map = {c.get('role_id'): c for c in global_characters}

    character_descriptions = []
    for role_id in characters_present:
        char = char_map.get(role_id)
        if char:
            char_name = char.get('name', '')
            gender = char.get('gender', '')
            features = char.get('permanent_features', '')
            if char_name and gender and features:
                character_descriptions.append(f"{role_id}（{char_name}）是{gender}，{features}")
            elif char_name and features:
                character_descriptions.append(f"{role_id}（{char_name}），{features}")
            elif gender and features:
                character_descriptions.append(f"{role_id}是{gender}，{features}")
            elif features:
                character_descriptions.append(f"{role_id}，{features}")
            elif char_name:
                character_descriptions.append(f"{role_id}（{char_name}）")
        else:
            character_descriptions.append(f"{role_id}")

    subtitles_part = ""
    if dialogues and isinstance(dialogues, list):
        dialogue_parts = []
        for d in dialogues:
            speaker = d.get('speaker', '')
            text = d.get('text', '')
            if speaker and text and speaker != 'null' and text != 'null':
                dialogue_parts.append(f"{speaker}：{text}")
            elif text and text != 'null':
                dialogue_parts.append(text)
        if dialogue_parts:
            subtitles_part = "，" + "；".join(dialogue_parts)

    main_prompt = f"整体视频的情节是{video_summary}，本片段是其中的一个分镜。{'；'.join(character_descriptions)}。{camera_movement}{scene_desc}{subtitles_part}。不要显示任何字幕，如果关键帧含有字幕，在生成片段时要去掉字幕。有人物对话时要严格按人物对话文本生成，不要随机生成对话。没有人物对话时则不要生成任何对话，也不要有对话的口型。"

    account_index = shot_index % len(accounts) if accounts else 0
    output_fps = int(os.environ.get('OUTPUT_FPS', 24))

    print(f"Shot {shot_index}: Starting with AI account index {account_index}")
    print(f"Shot {shot_index}: Duration: {duration:.3f}s, Target frames: {int(duration * output_fps)}")

    notify_subtask_python("update", shot_index, "PROCESSING")
    
    video_url = generate_video(accounts if accounts else None, account_index, [first_frame_url, middle_frame_url, last_frame_url], main_prompt, shot_index, duration, output_fps)

    if video_url:
        print(f"Downloading generated video for shot {shot_index}...")
        try:
            urllib.request.urlretrieve(video_url, f'./generated_shots/shot_{shot_index}.mp4')
            print(f"Successfully generated shot {shot_index}")
            output_path = f"{task_id}/generated_shots/shot_{shot_index}.mp4"
            notify_subtask_python("update", shot_index, "COMPLETED", output_path)
            return (shot_index, True)
        except Exception as e:
            print(f"Error downloading video for shot {shot_index}: {str(e)}")
            notify_subtask_python("update", shot_index, "FAILED", "", str(e))
            return (shot_index, False)
    else:
        print(f"Error: Failed to generate shot {shot_index}")
        notify_subtask_python("update", shot_index, "FAILED", "", "Failed to generate video")
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
subtask_index_str = os.environ.get('SUBTASK_INDEX', '')
if subtask_index_str:
    check_indices = [int(subtask_index_str)]
else:
    check_indices = list(range(len(storyboards)))
for i in check_indices:
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
if [ -n "$SUBTASK_INDEX" ]; then
    SUBTASK_FILE="./generated_shots/shot_${SUBTASK_INDEX}.mp4"
    if [ -f "$SUBTASK_FILE" ] && [ -s "$SUBTASK_FILE" ]; then
        echo "Shot generation subtask completed successfully. Shot ${SUBTASK_INDEX} generated."
    else
        echo "ERROR: Shot ${SUBTASK_INDEX} generation failed"
        exit 1
    fi
else
    if [ -n "$FINAL_MISSING" ]; then
        MISSING_COUNT=$(echo "$FINAL_MISSING" | tr ',' '\n' | grep -c .)
        echo "ERROR: $MISSING_COUNT shots failed after $MAX_ROUNDS rounds: [$FINAL_MISSING]"
        echo "Shots that could not be generated: $FINAL_MISSING"
        exit 1
    fi
    echo "Shot generation phase completed. All $SHOT_COUNT shots generated successfully."
fi
