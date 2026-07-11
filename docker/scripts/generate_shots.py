#!/usr/bin/env python3

import os
import sys
import json
import time
import subprocess
import urllib.request
import urllib.error
from datetime import datetime

def run_command(cmd):
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.stdout:
        print(f"  stdout: {result.stdout.strip()}")
    if result.stderr:
        print(f"  stderr: {result.stderr.strip()}")
    return result.returncode, result.stdout.strip()

def parse_time(time_str):
    try:
        return datetime.strptime(time_str, '%H:%M:%S.%f')
    except ValueError:
        try:
            return datetime.strptime(time_str, '%H:%M:%S')
        except ValueError:
            return datetime.strptime('00:00:00.000', '%H:%M:%S.%f')

def adjust_frames(frame_count):
    if frame_count < 9:
        return 9
    n = (frame_count - 1) // 8
    return 8 * n + 1

def create_video_task(api_url, api_key, json_data):
    req = urllib.request.Request(
        api_url,
        data=json_data.encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}'
        },
        method='POST'
    )
    
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode('utf-8')
            print(f"  HTTP code: {resp.status}")
            print(f"  Response: {body[:500]}")
            return resp.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        print(f"  HTTP code: {e.code}")
        print(f"  Response: {body[:500]}")
        return e.code, body
    except Exception as e:
        print(f"  Error: {e}")
        return 500, str(e)

def poll_video_task(api_url, api_key, task_id):
    max_polls = 90
    poll_interval = 10
    
    for i in range(max_polls):
        time.sleep(poll_interval)
        
        url = f"{api_url}/{task_id}"
        req = urllib.request.Request(
            url,
            headers={'Authorization': f'Bearer {api_key}'},
            method='GET'
        )
        
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode('utf-8')
                
                if resp.status >= 200 and resp.status < 300:
                    data = json.loads(body)
                    status = data.get('status', '')
                    progress = data.get('progress', '')
                    print(f"  Status: {status}, Progress: {progress}%")
                    
                    if status == 'completed':
                        for key in ['remixed_from_video_id', 'url', 'video_url', 'output_url', 'data.url']:
                            if '.' in key:
                                parts = key.split('.')
                                val = data
                                for part in parts:
                                    val = val.get(part, None)
                                    if val is None:
                                        break
                                if val:
                                    return val
                            else:
                                if data.get(key):
                                    return data.get(key)
                        return None
                    elif status == 'failed':
                        error = data.get('error', data.get('fail_reason', ''))
                        print(f"  Task failed: {error}")
                        return None
        except Exception as e:
            print(f"  Poll error: {e}")
    
    return None

def process_shot(shot_index, result, task_id, output_fps, r2_public_domain, ai_api_key, ai_base_url, ai_accounts):
    storyboards = result.get('storyboards', [])
    if shot_index >= len(storyboards):
        print(f"Shot {shot_index}: Index out of range")
        return shot_index, 'FAILED'
    
    shot = storyboards[shot_index]
    start_time = shot.get('start_time', '00:00:00.000')
    end_time = shot.get('end_time', '00:00:00.000')
    scene_desc = shot.get('scene_description', '')
    positive_prompt = shot.get('positive_prompt', '')
    dialogue = shot.get('dialogue', '')
    
    start_dt = parse_time(start_time)
    end_dt = parse_time(end_time)
    duration = (end_dt - start_dt).total_seconds()
    frame_count = int(duration * output_fps + 0.5)
    adjusted_frames = adjust_frames(frame_count)
    
    print(f"Processing shot {shot_index}: duration={duration:.3f}s, frames={frame_count}, adjusted_frames={adjusted_frames}")
    
    first_frame_url = f"https://{r2_public_domain}/{task_id}/ai_shot_frames/shot_{shot_index}_first.jpg"
    last_frame_url = f"https://{r2_public_domain}/{task_id}/ai_shot_frames/shot_{shot_index}_last.jpg"
    
    print(f"Shot {shot_index}: First frame URL: {first_frame_url}")
    print(f"Shot {shot_index}: Last frame URL: {last_frame_url}")
    
    base_prompt = "在两个参考图像之间创建一个平滑的过渡场景，保持角色身份一致性，动作自然。"
    main_prompt = f"{base_prompt}{positive_prompt}"
    if scene_desc:
        main_prompt += f", {scene_desc}"
    if dialogue:
        main_prompt += f", dialogue: {dialogue}"
    
    selected_key = ai_api_key
    selected_url = ai_base_url if ai_base_url else "https://apihub.agnes-ai.com/v1/videos"
    
    if ai_accounts:
        account_index = shot_index % len(ai_accounts)
        selected_key = ai_accounts[account_index].get('api_key_encrypted', ai_api_key)
        account_url = ai_accounts[account_index].get('base_url', '')
        if account_url:
            selected_url = account_url.replace('/v1/images/generations', '/v1/videos')
        else:
            selected_url = "https://apihub.agnes-ai.com/v1/videos"
    
    print(f"Shot {shot_index}: Using API key index {account_index if ai_accounts else 0}")
    print(f"Shot {shot_index}: API URL: {selected_url}")
    
    time.sleep(shot_index * 40)
    
    request_data = {
        'model': 'agnes-video-v2.0',
        'prompt': main_prompt,
        'num_frames': adjusted_frames,
        'frame_rate': 24,
        'width': 854,
        'height': 480,
        'seed': 42,
        'extra_body': {
            'image': [first_frame_url, last_frame_url],
            'mode': 'keyframes'
        }
    }
    
    json_data = json.dumps(request_data)
    print(f"Shot {shot_index}: Request body length: {len(json_data)}")
    
    max_retries = 3
    task_id_result = None
    
    for attempt in range(max_retries):
        print(f"Shot {shot_index}: Attempt {attempt+1}/{max_retries}...")
        
        status_code, response_body = create_video_task(selected_url, selected_key, json_data)
        
        if status_code >= 200 and status_code < 300:
            try:
                resp_data = json.loads(response_body)
                task_id_result = resp_data.get('task_id') or resp_data.get('id')
                if task_id_result:
                    print(f"Shot {shot_index}: Task ID: {task_id_result}")
                    break
            except json.JSONDecodeError:
                print(f"Shot {shot_index}: Failed to parse response")
        
        if attempt < max_retries - 1:
            time.sleep(10)
    
    if not task_id_result:
        print(f"Error: Failed to create video task for shot {shot_index}")
        return shot_index, 'FAILED'
    
    print(f"Shot {shot_index}: Polling task status...")
    result_url = poll_video_task(selected_url, selected_key, task_id_result)
    
    if not result_url:
        print(f"Error: Failed to get result URL for shot {shot_index}")
        return shot_index, 'FAILED'
    
    print(f"Shot {shot_index}: Result URL: {result_url}")
    
    output_path = f"./generated_shots/shot_{shot_index}.mp4"
    try:
        urllib.request.urlretrieve(result_url, output_path)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            print(f"Shot {shot_index}: Successfully downloaded video")
            return shot_index, 'SUCCESS'
        else:
            print(f"Error: Downloaded video is empty for shot {shot_index}")
            return shot_index, 'FAILED'
    except Exception as e:
        print(f"Error: Failed to download video: {e}")
        return shot_index, 'FAILED'

def main():
    print("=== Phase 7: Shot Generation ===")
    
    task_id = os.environ.get('TASK_ID')
    ai_account_id = os.environ.get('AI_ACCOUNT_ID')
    output_fps = int(os.environ.get('OUTPUT_FPS', '30'))
    
    print(f"Task ID: {task_id}")
    print(f"AI Account ID: {ai_account_id}")
    print(f"Output FPS: {output_fps}")
    
    work_dir = f"/tmp/{task_id}"
    os.makedirs(work_dir, exist_ok=True)
    os.chdir(work_dir)
    
    r2_public_domain = os.environ.get('R2_PUBLIC_DOMAIN', 'aivideobucket.ldragon.xyz')
    ai_api_key = os.environ.get('AI_API_KEY')
    ai_base_url = os.environ.get('AI_BASE_URL')
    ai_accounts_json = os.environ.get('AI_ACCOUNTS', '[]')
    
    ai_accounts = []
    try:
        ai_accounts = json.loads(ai_accounts_json)
    except:
        pass
    
    print(f"R2 Public Domain: {r2_public_domain}")
    print(f"Available AI accounts: {len(ai_accounts)}")
    
    r2_bucket_name = os.environ.get('R2_BUCKET_NAME')
    r2_endpoint_url = os.environ.get('R2_ENDPOINT_URL')
    
    print("Downloading analysis result...")
    run_command(f"aws s3 cp 's3://{r2_bucket_name}/{task_id}/analysis_result.json' ./analysis_result.json --endpoint-url '{r2_endpoint_url}'")
    
    with open('./analysis_result.json', 'r') as f:
        result = json.load(f)
    
    storyboards = result.get('storyboards', [])
    shot_count = len(storyboards)
    print(f"Found {shot_count} shots to generate")
    
    os.makedirs('./generated_shots', exist_ok=True)
    
    results = []
    for i in range(shot_count):
        shot_idx, status = process_shot(i, result, task_id, output_fps, r2_public_domain, ai_api_key, ai_base_url, ai_accounts)
        results.append((shot_idx, status))
        print(f"Shot {shot_idx}: {status}")
    
    success_count = sum(1 for _, s in results if s == 'SUCCESS')
    failed_count = sum(1 for _, s in results if s == 'FAILED')
    
    print("=== Shot Generation Complete ===")
    print(f"Total: {shot_count}")
    print(f"Success: {success_count}")
    print(f"Failed: {failed_count}")
    
    if success_count > 0:
        print("Uploading generated shots...")
        run_command(f"aws s3 sync './generated_shots' 's3://{r2_bucket_name}/{task_id}/generated_shots' --endpoint-url '{r2_endpoint_url}'")
    
    if success_count == 0:
        print("Error: No shots generated successfully")
        sys.exit(1)
    
    print("Shot generation phase completed.")

if __name__ == '__main__':
    main()