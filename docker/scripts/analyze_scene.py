#!/usr/bin/env python3
import os
import sys
import json
import time
import requests
import subprocess
import glob

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

def run_command(cmd, capture_output=True):
    print(f"Running: {cmd}")
    try:
        result = subprocess.run(cmd, shell=True, capture_output=capture_output, text=True, check=True)
        if capture_output and result.stdout:
            print(f"Output: {result.stdout[:500]}")
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Command failed: {e.stderr}")
        raise

def download_from_r2(source_path, local_path):
    cmd = f"aws s3 cp \"s3://{R2_BUCKET_NAME}/{source_path}\" \"{local_path}\" --endpoint-url \"{R2_ENDPOINT_URL}\""
    run_command(cmd)

def upload_to_r2(local_path, target_path, content_type="application/json"):
    cmd = f"aws s3 cp \"{local_path}\" \"s3://{R2_BUCKET_NAME}/{target_path}\" --endpoint-url \"{R2_ENDPOINT_URL}\" --content-type \"{content_type}\""
    run_command(cmd)

def read_file(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()

def upload_video_to_gemini(video_path):
    print("Uploading video to Gemini File API...")
    url = "https://generativelanguage.googleapis.com/upload/v1beta/files"
    
    with open(video_path, 'rb') as f:
        video_data = f.read()
    
    headers = {
        'x-goog-api-key': AI_API_KEY,
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-File-Name': os.path.basename(video_path),
    }
    
    response = requests.post(url, headers=headers, data=video_data, timeout=300)
    
    if response.status_code != 200:
        print(f"File upload failed: {response.status_code}")
        print(f"Response: {response.text}")
        raise Exception(f"File upload failed: {response.status_code} {response.text}")
    
    result = response.json()
    file_uri = result.get('fileUri') or result.get('file_uri')
    print(f"Upload successful, file_uri: {file_uri}")
    return file_uri

def call_gemini_api(file_uri, prompt_text, model_url=PRIMARY_MODEL_URL, attempt=1):
    print(f"Calling Gemini API (attempt {attempt}, model: {model_url})...")
    
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
        
        if response.status_code == 200:
            result = response.json()
            candidates = result.get('candidates', [])
            if candidates and candidates[0].get('content', {}).get('parts'):
                text = candidates[0]['content']['parts'][0].get('text', '')
                return text
        
        print(f"API call failed: {response.status_code}")
        print(f"Response: {response.text[:1000]}")
        
        if response.status_code in [429, 503, 500]:
            if model_url == PRIMARY_MODEL_URL and attempt <= 3:
                print(f"Retrying with fallback model: {FALLBACK_MODEL_URL}")
                return call_gemini_api(file_uri, prompt_text, FALLBACK_MODEL_URL, attempt + 1)
        
        return None
    except Exception as e:
        print(f"API call exception: {e}")
        if model_url == PRIMARY_MODEL_URL and attempt <= 3:
            print(f"Retrying with fallback model: {FALLBACK_MODEL_URL}")
            return call_gemini_api(file_uri, prompt_text, FALLBACK_MODEL_URL, attempt + 1)
        return None

def extract_scene_content(scenes_path):
    if os.path.exists(scenes_path):
        with open(scenes_path, 'r') as f:
            data = json.load(f)
        lines = []
        for s in data:
            lines.append(f"Shot {s['scene_number']}: {s['start_timecode']} -> {s['end_timecode']} ({s['length_seconds']}s)")
        return "\n".join(lines)
    return ""

def extract_srt_content(srt_path):
    if os.path.exists(srt_path):
        with open(srt_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    return ""

def parse_json_response(text):
    if not text:
        raise Exception("Empty response from API")
    
    text = text.strip()
    if text.startswith('```json'):
        text = text[7:]
    if text.endswith('```'):
        text = text[:-3]
    
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")
        print(f"Raw response: {text[:500]}")
        raise

def main():
    if not TASK_ID:
        print("Error: TASK_ID not set")
        sys.exit(1)
    
    if not AI_API_KEY:
        print("Error: AI_API_KEY not set")
        sys.exit(1)
    
    os.makedirs(WORK_DIR, exist_ok=True)
    os.chdir(WORK_DIR)
    
    print(f"=== Phase 2: Scene Analysis ===")
    print(f"Task ID: {TASK_ID}")
    print(f"Video Path: {VIDEO_PATH}")
    
    video_local_path = "./input_video.mp4"
    download_from_r2(VIDEO_PATH, video_local_path)
    
    srt_path = VIDEO_PATH.rsplit('.', 1)[0] + '.srt'
    srt_local_path = "./input_video.srt"
    try:
        download_from_r2(srt_path, srt_local_path)
        print(f"Downloaded SRT: {srt_path}")
    except Exception as e:
        print(f"SRT file not found, proceeding without subtitles: {e}")
    
    scenes_json_path = f"{TASK_ID}/scenes/scenes.json"
    scenes_local_path = "./scenes.json"
    try:
        download_from_r2(scenes_json_path, scenes_local_path)
    except Exception as e:
        print(f"Scenes JSON not found, trying CSV: {e}")
    
    scene_content = extract_scene_content(scenes_local_path)
    srt_content = extract_srt_content(srt_local_path)
    
    print(f"Scene content:\n{scene_content}")
    print(f"SRT content length: {len(srt_content)} chars")
    
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
        result_text = call_gemini_api(file_uri, prompt_text)
        if result_text:
            break
        if attempt < max_retries:
            print(f"Retrying in {retry_delay} seconds...")
            time.sleep(retry_delay)
    
    if not result_text:
        print("Error: AI API call failed after all retries")
        sys.exit(1)
    
    print("Parsing analysis result...")
    result_json = parse_json_response(result_text)
    
    output_path = "./analysis_result.json"
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result_json, f, ensure_ascii=False, indent=2)
    
    upload_to_r2(output_path, f"{TASK_ID}/analysis_result.json", "application/json")
    
    print("Phase 2 completed: Scene analysis done")
    
    result_json_output = {
        "taskId": TASK_ID,
        "resultPath": f"{TASK_ID}/analysis_result.json"
    }
    with open("/tmp/result.json", 'w', encoding='utf-8') as f:
        json.dump(result_json_output, f)

if __name__ == "__main__":
    main()