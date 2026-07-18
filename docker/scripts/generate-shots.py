#!/usr/bin/env python3
import json
import os
import sys
import time
import urllib.request
import urllib.error
import ssl

ssl._create_default_https_context = ssl._create_unverified_context

def main():
    task_id = os.environ.get('TASK_ID')
    ai_accounts_json = os.environ.get('AI_ACCOUNTS', '[]')
    r2_bucket = os.environ.get('R2_BUCKET_NAME')
    r2_endpoint = os.environ.get('R2_ENDPOINT_URL')

    with open('./analysis_result.json', 'r') as f:
        result = json.load(f)

    storyboards = result.get('storyboards', [])
    accounts = json.loads(ai_accounts_json)

    def parse_time(time_str):
        parts = time_str.split(':')
        h = int(parts[0])
        m = int(parts[1])
        s_parts = parts[2].split('.')
        s = int(s_parts[0])
        ms = int(s_parts[1]) if len(s_parts) > 1 else 0
        return h * 3600 + m * 60 + s + ms / 1000

    def generate_video(account, image_urls, prompt, shot_index):
        api_key = account.get('api_key_encrypted', '')
        base_url = account.get('base_url', 'https://apihub.agnes-ai.com/v1/videos')
        model_name = account.get('model_name', 'agnes-video-v2.0')
        
        if not base_url.startswith('http'):
            base_url = 'https://' + base_url
        
        full_prompt = "在两个参考图像之间创建一个平滑的过渡场景，保持角色身份一致性，动作自然。" + prompt
        
        request_body = {
            'model': model_name,
            'prompt': full_prompt,
            'extra_body': {
                'image': image_urls,
                'mode': 'keyframes'
            },
            'num_frames': 361,
            'frame_rate': 24,
            'width': 854,
            'height': 480,
            'seed': 42
        }
        
        json_data = json.dumps(request_body).encode('utf-8')
        
        headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + api_key
        }
        
        task_id_result = None
        max_retries = 3
        retry_delay = 10
        
        for attempt in range(max_retries):
            try:
                req = urllib.request.Request(base_url, data=json_data, headers=headers, method='POST')
                resp = urllib.request.urlopen(req, timeout=300)
                resp_body = resp.read().decode('utf-8')
                resp_data = json.loads(resp_body)
                
                print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} - HTTP 200")
                print(f"  Shot {shot_index}: Response: {resp_body[:500]}...")
                
                task_id_result = resp_data.get('task_id') or resp_data.get('id') or resp_data.get('taskId')
                
                if task_id_result:
                    print(f"  Shot {shot_index}: Got task ID: {task_id_result}")
                    break
                    
                url = resp_data.get('remixed_from_video_id') or resp_data.get('video_url') or resp_data.get('output_url') or resp_data.get('url')
                if url:
                    print(f"  Shot {shot_index}: Got direct URL: {url}")
                    return url
                    
            except Exception as e:
                print(f"  Shot {shot_index}: Attempt {attempt+1}/{max_retries} failed: {str(e)}")
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
        
        if not task_id_result:
            print(f"  Shot {shot_index}: Failed to get task ID after {max_retries} attempts")
            return None
        
        print(f"  Shot {shot_index}: Polling for result...")
        max_polls = 90
        poll_interval = 10
        
        for poll_attempt in range(max_polls):
            time.sleep(poll_interval)
            try:
                poll_url = f"{base_url}/{task_id_result}"
                req = urllib.request.Request(poll_url, headers={'Authorization': 'Bearer ' + api_key}, method='GET')
                resp = urllib.request.urlopen(req, timeout=30)
                resp_body = resp.read().decode('utf-8')
                resp_data = json.loads(resp_body)
                
                status = resp_data.get('status', '')
                progress = resp_data.get('progress', 0)
                print(f"  Shot {shot_index}: Poll {poll_attempt+1}/{max_polls} - Status: {status}, Progress: {progress}%")
                
                if status == 'completed':
                    url = resp_data.get('remixed_from_video_id') or resp_data.get('video_url') or resp_data.get('output_url') or resp_data.get('url')
                    if isinstance(resp_data.get('data'), dict):
                        url = url or resp_data.get('data').get('url')
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

    os.makedirs('./generated_shots', exist_ok=True)
    
    success_count = 0
    failed_count = 0

    for shot_index, shot in enumerate(storyboards):
        start_time = shot.get('start_time', '00:00:00.000')
        end_time = shot.get('end_time', '00:00:00.000')
        start_sec = parse_time(start_time)
        end_sec = parse_time(end_time)
        duration = end_sec - start_sec
        
        print(f"Processing shot {shot_index}: {start_time} - {end_time} (duration={duration:.3f}s)")
        
        r2_public_url = os.environ.get('R2_PUBLIC_URL', 'https://aivideobucket.ldragon.xyz')
        first_frame_url = f"{r2_public_url}/{task_id}/ai_shot_frames/shot_{shot_index}_first.jpg"
        last_frame_url = f"{r2_public_url}/{task_id}/ai_shot_frames/shot_{shot_index}_last.jpg"
        
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
        account = accounts[account_index] if accounts else {'api_key_encrypted': os.environ.get('AI_API_KEY', ''), 'base_url': os.environ.get('AI_BASE_URL', 'https://apihub.agnes-ai.com/v1/videos'), 'model_name': 'agnes-video-v2.0'}
        
        print(f"Shot {shot_index}: Using model {account.get('model_name', 'agnes-video-v2.0')} at {account.get('base_url', '')}")
        print(f"Shot {shot_index}: Using AI account index {account_index}")
        
        video_url = generate_video(account, [first_frame_url, last_frame_url], main_prompt, shot_index)
        
        if video_url:
            print(f"Downloading generated video for shot {shot_index}...")
            try:
                urllib.request.urlretrieve(video_url, f'./generated_shots/shot_{shot_index}.mp4')
                print(f"Successfully generated shot {shot_index}")
                success_count += 1
            except Exception as e:
                print(f"Error downloading video for shot {shot_index}: {str(e)}")
                failed_count += 1
        else:
            print(f"Error: Failed to generate shot {shot_index}")
            failed_count += 1

    print("=== Shot Generation Complete ===")
    print(f"Total: {len(storyboards)}")
    print(f"Success: {success_count}")
    print(f"Failed: {failed_count}")

    if failed_count > 0:
        sys.exit(1)

if __name__ == '__main__':
    main()