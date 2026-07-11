#!/usr/bin/env python3
import os
import sys
import json
import time
import requests
import subprocess
import traceback

TASK_ID = os.environ.get('TASK_ID')
AI_API_KEY = os.environ.get('AI_API_KEY')
AI_BASE_URL = os.environ.get('AI_BASE_URL')
VIDEO_PATH = os.environ.get('VIDEO_PATH')
R2_ACCESS_KEY_ID = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_ENDPOINT_URL = os.environ.get('R2_ENDPOINT_URL')
R2_BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

PRIMARY_MODEL_URL = AI_BASE_URL or "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
FALLBACK_MODEL_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent"

WORK_DIR = f"/tmp/{TASK_ID}"

def log(msg):
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"[{timestamp}] {msg}")

def run_command(cmd, capture_output=True):
    log(f"Running command: {cmd}")
    try:
        result = subprocess.run(cmd, shell=True, capture_output=capture_output, text=True, check=True)
        if capture_output and result.stdout:
            log(f"Command output: {result.stdout[:1000]}")
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        log(f"Command failed with exit code {e.returncode}")
        if e.stderr:
            log(f"Error output: {e.stderr[:1000]}")
        raise

def download_from_r2(source_path, local_path):
    log(f"Downloading from R2: s3://{R2_BUCKET_NAME}/{source_path} -> {local_path}")
    cmd = f"aws s3 cp \"s3://{R2_BUCKET_NAME}/{source_path}\" \"{local_path}\" --endpoint-url \"{R2_ENDPOINT_URL}\""
    run_command(cmd)

def upload_to_r2(local_path, target_path, content_type="application/json"):
    log(f"Uploading to R2: {local_path} -> s3://{R2_BUCKET_NAME}/{target_path}")
    cmd = f"aws s3 cp \"{local_path}\" \"s3://{R2_BUCKET_NAME}/{target_path}\" --endpoint-url \"{R2_ENDPOINT_URL}\" --content-type \"{content_type}\""
    run_command(cmd)

def read_file(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()

def upload_video_to_gemini(video_path):
    log("Uploading video to Gemini File API...")
    
    if not os.path.exists(video_path):
        raise Exception(f"Video file not found: {video_path}")
    
    file_size = os.path.getsize(video_path)
    log(f"Video file size: {file_size} bytes")
    
    url = "https://generativelanguage.googleapis.com/upload/v1beta/files"
    
    with open(video_path, 'rb') as f:
        video_data = f.read()
    
    headers = {
        'x-goog-api-key': AI_API_KEY,
    }
    
    metadata = {
        "displayName": os.path.basename(video_path),
        "mimeType": "video/mp4",
    }
    
    files = {
        'metadata': ('metadata', json.dumps(metadata), 'application/json'),
        'file': (os.path.basename(video_path), video_data, 'video/mp4'),
    }
    
    try:
        response = requests.post(url, headers=headers, files=files, timeout=300)
    except requests.exceptions.RequestException as e:
        log(f"Request exception: {e}")
        raise
    
    log(f"Upload response status: {response.status_code}")
    log(f"Full upload response: {response.text[:2000]}")
    
    if response.status_code != 200:
        log(f"File upload failed: HTTP {response.status_code}")
        log(f"Response: {response.text[:2000]}")
        
        log("Trying resumable upload...")
        url_resumable = "https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable"
        
        try:
            init_response = requests.post(url_resumable, headers={
                'x-goog-api-key': AI_API_KEY,
                'Content-Type': 'application/json',
            }, json=metadata, timeout=300)
            
            log(f"Resumable init status: {init_response.status_code}")
            log(f"Resumable init response: {init_response.text[:500]}")
            
            if init_response.status_code == 200:
                location = init_response.headers.get('Location')
                if location:
                    log(f"Resumable upload location: {location}")
                    response = requests.put(location, headers={
                        'Content-Type': 'video/mp4',
                        'Content-Length': str(file_size),
                    }, data=video_data, timeout=300)
                    log(f"Resumable upload status: {response.status_code}")
                    log(f"Resumable upload response: {response.text[:2000]}")
        except requests.exceptions.RequestException as e:
            log(f"Resumable upload exception: {e}")
        
        if response.status_code != 200:
            raise Exception(f"File upload failed: {response.status_code} {response.text}")
    
    try:
        result = response.json()
    except json.JSONDecodeError:
        log(f"Response is not JSON: {response.text[:500]}")
        raise Exception(f"File upload response is not JSON: {response.text[:500]}")
    
    log(f"Parsed upload response: {json.dumps(result)}")
    
    file_uri = result.get('fileUri') or result.get('file_uri') or result.get('uri')
    
    if not file_uri:
        log(f"Available keys in response: {list(result.keys())}")
        raise Exception("fileUri not found in upload response")
    
    log(f"Upload successful, file_uri: {file_uri}")
    return file_uri

def call_gemini_api(file_uri, prompt_text, model_url=PRIMARY_MODEL_URL, attempt=1):
    log(f"Calling Gemini API (attempt {attempt}, model: {model_url})...")
    log(f"Prompt text length: {len(prompt_text)} chars")
    
    payload = {
        "contents": [{
            "parts": [
                {
                    "text": prompt_text
                },
                {
                    "file_data": {
                        "mime_type": "video/mp4",
                        "file_uri": file_uri
                    }
                }
            ]
        }],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json"
        }
    }
    
    headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': AI_API_KEY
    }
    
    try:
        response = requests.post(model_url, headers=headers, json=payload, timeout=300)
        
        log(f"API response status: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            log(f"API response received, parsing...")
            
            candidates = result.get('candidates', [])
            if candidates and candidates[0].get('content', {}).get('parts'):
                text = candidates[0]['content']['parts'][0].get('text', '')
                log(f"API response text length: {len(text)} chars")
                return text
            
            log(f"No valid response found in candidates")
            log(f"Full response: {json.dumps(result)[:2000]}")
        
        else:
            log(f"API call failed: HTTP {response.status_code}")
            log(f"Response: {response.text[:2000]}")
            
            if response.status_code in [429, 503, 500]:
                if model_url == PRIMARY_MODEL_URL and attempt <= 3:
                    log(f"Retrying with fallback model: {FALLBACK_MODEL_URL}")
                    return call_gemini_api(file_uri, prompt_text, FALLBACK_MODEL_URL, attempt + 1)
        
        return None
    except requests.exceptions.RequestException as e:
        log(f"API call exception: {e}")
        if model_url == PRIMARY_MODEL_URL and attempt <= 3:
            log(f"Retrying with fallback model: {FALLBACK_MODEL_URL}")
            return call_gemini_api(file_uri, prompt_text, FALLBACK_MODEL_URL, attempt + 1)
        return None

def extract_scene_content(scenes_path):
    if os.path.exists(scenes_path):
        log(f"Reading scenes from: {scenes_path}")
        with open(scenes_path, 'r') as f:
            data = json.load(f)
        lines = []
        for s in data:
            lines.append(f"Shot {s['scene_number']}: {s['start_timecode']} -> {s['end_timecode']} ({s['length_seconds']}s)")
        content = "\n".join(lines)
        log(f"Scene content: {content}")
        return content
    log(f"Scenes file not found: {scenes_path}")
    return ""

def extract_srt_content(srt_path):
    if os.path.exists(srt_path):
        log(f"Reading SRT from: {srt_path}")
        content = read_file(srt_path)
        log(f"SRT content length: {len(content)} chars")
        return content
    log(f"SRT file not found: {srt_path}")
    return ""

def parse_json_response(text):
    if not text:
        raise Exception("Empty response from API")
    
    text = text.strip()
    log(f"Raw response (first 500 chars): {text[:500]}")
    
    if text.startswith('```json'):
        text = text[7:]
        log("Stripped ```json prefix")
    if text.endswith('```'):
        text = text[:-3]
        log("Stripped ``` suffix")
    
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        log(f"JSON parse error: {e}")
        log(f"Full response text: {text}")
        raise

def main():
    try:
        log("Starting scene analysis phase")
        
        if not TASK_ID:
            log("Error: TASK_ID not set")
            sys.exit(1)
        
        if not AI_API_KEY:
            log("Error: AI_API_KEY not set")
            sys.exit(1)
        
        if not VIDEO_PATH:
            log("Error: VIDEO_PATH not set")
            sys.exit(1)
        
        log(f"Environment variables:")
        log(f"  TASK_ID: {TASK_ID}")
        log(f"  AI_API_KEY: {'set' if AI_API_KEY else 'not set'}")
        log(f"  AI_BASE_URL: {AI_BASE_URL}")
        log(f"  VIDEO_PATH: {VIDEO_PATH}")
        log(f"  R2_BUCKET_NAME: {R2_BUCKET_NAME}")
        log(f"  PRIMARY_MODEL_URL: {PRIMARY_MODEL_URL}")
        
        os.makedirs(WORK_DIR, exist_ok=True)
        os.chdir(WORK_DIR)
        
        log(f"Working directory: {WORK_DIR}")
        
        video_local_path = "./input_video.mp4"
        log(f"Downloading video: {VIDEO_PATH} -> {video_local_path}")
        download_from_r2(VIDEO_PATH, video_local_path)
        
        srt_path = VIDEO_PATH.rsplit('.', 1)[0] + '.srt'
        srt_local_path = "./input_video.srt"
        log(f"Downloading SRT: {srt_path} -> {srt_local_path}")
        try:
            download_from_r2(srt_path, srt_local_path)
            log(f"SRT downloaded successfully")
        except Exception as e:
            log(f"SRT file not found, proceeding without subtitles: {str(e)[:200]}")
        
        scenes_json_path = f"{TASK_ID}/scenes/scenes.json"
        scenes_local_path = "./scenes.json"
        log(f"Downloading scenes: {scenes_json_path} -> {scenes_local_path}")
        try:
            download_from_r2(scenes_json_path, scenes_local_path)
            log(f"Scenes JSON downloaded successfully")
        except Exception as e:
            log(f"Scenes JSON not found, trying CSV: {str(e)[:200]}")
        
        scene_content = extract_scene_content(scenes_local_path)
        srt_content = extract_srt_content(srt_local_path)
        
        if not scene_content:
            log("Warning: No scene content found")
        
        prompt_text = f"""你是一个专业的视频分析助手。请分析以下视频的剧情和分镜结构。

视频信息：
- 镜头切分结果：
{scene_content}

字幕内容：
{srt_content}

分析要求：
1. 合并细碎镜头为完整剧情分镜，每个分镜时长不超过15秒
2. 输出全局角色档案，包括：
   - role_id（R1, R2, R3...）
   - 性别、体型、身高特征
   - 永久固定特征（跨画风有效识别特征，如发型、面部特征）
   - 人物差异化标签（不记录临时服装、光线、镜头角度）
3. 每段分镜输出：
   - 精确起止时间（修改后的）
   - 本段所有出场人物role_id
   - 本段发言人role_id
   - 完整台词字幕（如果有）
   - 场景描述
   - 光影描述
   - 运镜描述
   - 正向prompt（用于AI生成）
   - 反向prompt（用于排除不想要的元素）

请以JSON格式输出结果。"""
        
        file_uri = upload_video_to_gemini(video_local_path)
        
        max_retries = 3
        retry_delay = 10
        result_text = None
        
        for attempt in range(1, max_retries + 1):
            log(f"API call attempt {attempt}/{max_retries}")
            result_text = call_gemini_api(file_uri, prompt_text)
            if result_text:
                log("API call successful")
                break
            if attempt < max_retries:
                log(f"Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
        
        if not result_text:
            log("Error: AI API call failed after all retries")
            sys.exit(1)
        
        log("Parsing analysis result...")
        result_json = parse_json_response(result_text)
        
        output_path = "./analysis_result.json"
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result_json, f, ensure_ascii=False, indent=2)
        log(f"Analysis result saved to: {output_path}")
        
        upload_to_r2(output_path, f"{TASK_ID}/analysis_result.json", "application/json")
        log(f"Analysis result uploaded to R2")
        
        log("Phase 2 completed: Scene analysis done")
        
        result_json_output = {
            "taskId": TASK_ID,
            "resultPath": f"{TASK_ID}/analysis_result.json"
        }
        with open("/tmp/result.json", 'w', encoding='utf-8') as f:
            json.dump(result_json_output, f)
        log("Result JSON written to /tmp/result.json")
        
    except Exception as e:
        error_msg = f"Error in scene analysis: {e}\nTraceback: {traceback.format_exc()}"
        log(error_msg)
        
        error_log_path = "./error_log.txt"
        with open(error_log_path, 'w', encoding='utf-8') as f:
            f.write(error_msg)
        
        try:
            upload_to_r2(error_log_path, f"{TASK_ID}/error_log.txt", "text/plain")
            log("Error log uploaded to R2")
        except Exception as upload_err:
            log(f"Failed to upload error log: {upload_err}")
        
        sys.exit(1)

if __name__ == "__main__":
    main()