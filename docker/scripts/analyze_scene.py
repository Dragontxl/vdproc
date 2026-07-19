#!/usr/bin/env python3
import os
import sys
import json
import time
import traceback
import io
import google.generativeai as genai

TASK_ID = os.environ.get('TASK_ID')
AI_API_KEY = os.environ.get('AI_API_KEY')
AI_BASE_URL = os.environ.get('AI_BASE_URL')
VIDEO_PATH = os.environ.get('VIDEO_PATH')
R2_ACCESS_KEY_ID = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_ENDPOINT_URL = os.environ.get('R2_ENDPOINT_URL')
R2_BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

PRIMARY_MODEL = "models/gemini-3.5-flash"
FALLBACK_MODEL = "models/gemini-3.1-flash-lite"

WORK_DIR = f"/tmp/{TASK_ID}"

def log(msg):
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"[{timestamp}] {msg}")

def run_command(cmd, capture_output=True):
    import subprocess
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
    log("Uploading video to Gemini using google.generativeai SDK...")
    
    if not os.path.exists(video_path):
        raise Exception(f"Video file not found: {video_path}")
    
    file_size = os.path.getsize(video_path)
    log(f"Video file size: {file_size} bytes")
    
    with open(video_path, 'rb') as f:
        video_data = f.read()
    
    video_stream = io.BytesIO(video_data)
    
    log("Calling genai.upload_file...")
    video_file = genai.upload_file(
        path=video_stream,
        mime_type="video/mp4"
    )
    
    log(f"Upload started, file name: {video_file.name}, state: {video_file.state.name}")
    
    log("Waiting for video processing...")
    while video_file.state.name == "PROCESSING":
        time.sleep(2)
        video_file = genai.get_file(video_file.name)
        log(f"Processing state: {video_file.state.name}")
    
    if video_file.state.name == "FAILED":
        raise ValueError("视频处理失败")
    
    log(f"Video processing completed, file URI: {video_file.uri}")
    return video_file

def call_gemini_api(video_file, prompt_text, model_name=PRIMARY_MODEL, attempt=1):
    log(f"Calling Gemini API (attempt {attempt}, model: {model_name})...")
    log(f"Prompt text length: {len(prompt_text)} chars")
    
    try:
        model = genai.GenerativeModel(model_name)
        response = model.generate_content([prompt_text, video_file])
        
        if response.parts and len(response.parts) > 0:
            text = response.text
            if text:
                text = text.strip()
            log(f"API response text length: {len(text) if text else 0} chars")
            if text and len(text) > 0:
                return text
            else:
                log("API response is empty or whitespace only")
        
        log(f"No valid response found")
        if response.candidates:
            log(f"Candidates: {json.dumps(response.candidates[:1], default=str)[:2000]}")
        if hasattr(response, 'usage_metadata'):
            log(f"Usage metadata: {json.dumps(response.usage_metadata, default=str)}")
        
        return None
    except Exception as e:
        log(f"API call exception: {e}")
        log(f"Exception type: {type(e).__name__}")
        
        if model_name == PRIMARY_MODEL and attempt <= 3:
            log(f"Retrying with fallback model: {FALLBACK_MODEL}")
            return call_gemini_api(video_file, prompt_text, FALLBACK_MODEL, attempt + 1)
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
    log(f"Raw response (last 500 chars): {text[-500:]}")
    
    if text.startswith('```json'):
        text = text[7:]
        log("Stripped ```json prefix")
    if text.startswith('```'):
        text = text[3:]
        log("Stripped ``` prefix")
    if text.endswith('```'):
        text = text[:-3]
        log("Stripped ``` suffix")
    
    text = text.strip()
    
    first_brace = text.find('{')
    last_brace = text.rfind('}')
    
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        text = text[first_brace:last_brace+1]
        log(f"Extracted JSON from {first_brace} to {last_brace}, length: {len(text)}")
    else:
        log(f"Warning: Could not find matching braces, first_brace={first_brace}, last_brace={last_brace}")
    
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        log(f"JSON parse error: {e}")
        log(f"Error location: line {e.lineno}, column {e.colno}, char {e.pos}")
        log(f"Text around error ({e.pos-50} to {e.pos+50}): {text[max(0,e.pos-50):e.pos+50]}")
        log(f"Full response text (first 2000 chars): {text[:2000]}")
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
        log(f"  PRIMARY_MODEL: {PRIMARY_MODEL}")
        
        genai.configure(api_key=AI_API_KEY)
        log("Google GenerativeAI configured")
        
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
        
        has_srt = len(srt_content.strip()) > 0
        
        if has_srt:
            subtitle_section = f"Subtitle content:\n{srt_content}"
            subtitle_instruction = "Subtitles are provided. Please strictly use the provided subtitle content. Do not extract or infer any dialogue from the video yourself."
        else:
            subtitle_section = "Subtitle content: None (please identify dialogue from video)"
            subtitle_instruction = "No subtitle file provided. Please analyze and identify dialogue content from the video."
        
        prompt_text = f"""You are a professional video analysis assistant. Please analyze the plot and shot structure of the following video.

Video Information:
- Scene detection results:
{scene_content}

{subtitle_section}

{subtitle_instruction}

Analysis Requirements:
1. Merge fragmented shots into complete story shots, each shot duration should not exceed 15 seconds
2. Output global character profiles including:
   - role_id (R1, R2, R3...)
   - gender, body type, height characteristics
   - permanent features (cross-style effective identification features such as hairstyle, facial features)
   - differentiation labels (do not record temporary clothing, lighting, camera angles)
   - best_face_time (timestamp of the best face frame for this character, format HH:MM:SS.mmm, select the clearest, front-facing, and complete facial frame)
   - face_position_x (horizontal position of face in frame, normalized 0-1, 0 is leftmost, 1 is rightmost)
   - face_position_y (vertical position of face in frame, normalized 0-1, 0 is topmost, 1 is bottommost)
3. For each shot, output:
   - Precise start and end times (modified)
   - All character role_ids present in this shot
   - Speaker role_id for this shot
   - Complete dialogue subtitles (follow subtitle rules above)
   - Scene description
   - Lighting description
   - Camera movement description
   - Positive prompt (for AI generation)
   - Negative prompt (for excluding unwanted elements)

IMPORTANT: Output ALL content in ENGLISH ONLY. Translate any Chinese text from subtitles or video content to English. If content is duplicated in both Chinese and English, keep only the English version.

Please output strictly in the following JSON format, must contain both 'characters' and 'storyboards' top-level keys:

{{
  "characters": [
    {{
      "role_id": "R1",
      "gender": "male",
      "body_type": "medium build",
      "height": "medium to tall",
      "permanent_features": "description",
      "differentiation_labels": ["label1", "label2"],
      "best_face_time": "00:00:02.500",
      "face_position_x": 0.5,
      "face_position_y": 0.3
    }}
  ],
  "storyboards": [
    {{
      "start_time": "00:00:00.000",
      "end_time": "00:00:05.000",
      "characters_present": ["R1"],
      "speaker": "R1",
      "subtitles": "dialogue content",
      "scene_description": "scene description",
      "lighting_description": "lighting description",
      "camera_movement": "camera movement description",
      "positive_prompt": "AI generation positive prompt",
      "negative_prompt": "AI generation negative prompt"
    }}
  ]
}}

Notes:
- start_time, end_time, and best_face_time must use HH:MM:SS.mmm format
- storyboards array cannot be empty, must contain at least one shot
- characters_present and differentiation_labels must be arrays
- speaker can be null
- best_face_time must select the clearest, front-facing, and complete facial frame for accurate face extraction
- Do not add any additional top-level keys"""
        
        video_file = upload_video_to_gemini(video_local_path)
        
        max_retries = 3
        retry_delay = 10
        result_text = None
        
        for attempt in range(1, max_retries + 1):
            log(f"API call attempt {attempt}/{max_retries}")
            result_text = call_gemini_api(video_file, prompt_text)
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