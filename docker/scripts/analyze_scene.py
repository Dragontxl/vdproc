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

def parse_time_to_seconds(time_str):
    try:
        parts = time_str.split(':')
        h = int(parts[0])
        m = int(parts[1])
        s_parts = parts[2].split('.')
        s = int(s_parts[0])
        ms = int(s_parts[1]) if len(s_parts) > 1 else 0
        return h * 3600 + m * 60 + s + ms / 1000
    except Exception:
        return None

def seconds_to_time_str(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"

def get_video_duration(video_path):
    try:
        import subprocess
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except Exception as e:
        log(f"Warning: Failed to get video duration with ffprobe: {e}")
    try:
        result = subprocess.run(
            ['ffmpeg', '-i', video_path],
            capture_output=True, text=True, timeout=30
        )
        import re
        match = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', result.stderr)
        if match:
            h = int(match.group(1))
            m = int(match.group(2))
            s = float(match.group(3))
            return h * 3600 + m * 60 + s
    except Exception as e:
        log(f"Warning: Failed to get video duration with ffmpeg: {e}")
    return None

def validate_and_fix_storyboards(result_json, video_duration=None, scenes_data=None):
    storyboards = result_json.get('storyboards', [])
    if not storyboards:
        log("Warning: No storyboards found in result")
        return result_json

    log(f"Validating {len(storyboards)} storyboards...")
    fixed_count = 0

    scenes_map = {}
    if scenes_data:
        for s in scenes_data:
            idx = s.get('scene_number', 0)
            scenes_map[idx] = {
                'start': s.get('start_timecode', ''),
                'end': s.get('end_timecode', ''),
                'duration': s.get('length_seconds', 0)
            }

    for i, shot in enumerate(storyboards):
        start_str = shot.get('start_time', '')
        end_str = shot.get('end_time', '')
        start_sec = parse_time_to_seconds(start_str)
        end_sec = parse_time_to_seconds(end_str)

        needs_fix = False

        if start_sec is None:
            log(f"  Shot {i}: Invalid start_time format: {start_str}")
            needs_fix = True
        if end_sec is None:
            log(f"  Shot {i}: Invalid end_time format: {end_str}")
            needs_fix = True

        if start_sec is not None and end_sec is not None and end_sec <= start_sec:
            log(f"  Shot {i}: end_time ({end_str}) <= start_time ({start_str}), duration={end_sec - start_sec:.3f}s")
            needs_fix = True

        if needs_fix:
            fixed_count += 1
            scene_info = scenes_map.get(i, {})
            scene_start = parse_time_to_seconds(scene_info.get('start', ''))
            scene_end = parse_time_to_seconds(scene_info.get('end', ''))
            scene_duration = scene_info.get('duration', 0)

            if start_sec is None and scene_start is not None:
                start_sec = scene_start
                log(f"    Using scene start_time: {seconds_to_time_str(start_sec)}")
            elif start_sec is None:
                if i == 0:
                    start_sec = 0.0
                else:
                    prev_end = parse_time_to_seconds(storyboards[i-1].get('end_time', ''))
                    start_sec = prev_end if prev_end is not None else 0.0
                log(f"    Fallback start_time: {seconds_to_time_str(start_sec)}")

            if end_sec is None or end_sec <= start_sec:
                if scene_end is not None and scene_end > start_sec:
                    end_sec = scene_end
                    log(f"    Using scene end_time: {seconds_to_time_str(end_sec)}")
                elif scene_duration and scene_duration > 0:
                    end_sec = start_sec + scene_duration
                    log(f"    Using scene duration: {scene_duration}s -> end_time: {seconds_to_time_str(end_sec)}")
                elif i < len(storyboards) - 1:
                    next_start = parse_time_to_seconds(storyboards[i+1].get('start_time', ''))
                    if next_start is not None and next_start > start_sec:
                        end_sec = next_start
                        log(f"    Using next shot start_time: {seconds_to_time_str(end_sec)}")
                    else:
                        end_sec = start_sec + 5.0
                        log(f"    Fallback: adding 5s -> end_time: {seconds_to_time_str(end_sec)}")
                else:
                    if video_duration and video_duration > start_sec:
                        end_sec = video_duration
                        log(f"    Using video duration: {video_duration}s -> end_time: {seconds_to_time_str(end_sec)}")
                    else:
                        end_sec = start_sec + 5.0
                        log(f"    Fallback: adding 5s -> end_time: {seconds_to_time_str(end_sec)}")

            if video_duration and end_sec > video_duration:
                end_sec = video_duration
                log(f"    Clamping end_time to video duration: {seconds_to_time_str(end_sec)}")
            if video_duration and start_sec > video_duration:
                start_sec = max(0, video_duration - 1.0)
                log(f"    Clamping start_time to video duration: {seconds_to_time_str(start_sec)}")

            shot['start_time'] = seconds_to_time_str(start_sec)
            shot['end_time'] = seconds_to_time_str(end_sec)

    log("Validating storyboard sequence...")
    for i in range(1, len(storyboards)):
        prev_end = parse_time_to_seconds(storyboards[i-1].get('end_time', ''))
        curr_start = parse_time_to_seconds(storyboards[i].get('start_time', ''))
        
        if prev_end is not None and curr_start is not None and curr_start < prev_end:
            log(f"  Shot {i}: start_time ({storyboards[i]['start_time']}) < previous end_time ({storyboards[i-1]['end_time']})")
            storyboards[i]['start_time'] = seconds_to_time_str(prev_end)
            fixed_count += 1
            
            curr_end = parse_time_to_seconds(storyboards[i].get('end_time', ''))
            if curr_end is not None and curr_end <= prev_end:
                new_end = prev_end + 3.0
                if video_duration and new_end > video_duration:
                    new_end = video_duration
                storyboards[i]['end_time'] = seconds_to_time_str(new_end)
                log(f"    Also fixed end_time: {storyboards[i]['end_time']}")

    if video_duration:
        last_end = parse_time_to_seconds(storyboards[-1].get('end_time', ''))
        if last_end is not None and last_end > video_duration:
            storyboards[-1]['end_time'] = seconds_to_time_str(video_duration)
            log(f"  Last shot end_time clamped to video duration: {seconds_to_time_str(video_duration)}")
            fixed_count += 1

    log(f"Validation complete: fixed {fixed_count} issues")
    return result_json

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
    
    text = text.strip()
    
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        log(f"JSON parse error: {e}")
        log(f"Attempting to extract valid JSON...")
        
        first_brace = text.find('{')
        last_brace = text.rfind('}')
        
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            extracted = text[first_brace:last_brace+1]
            log(f"Extracted JSON from position {first_brace} to {last_brace}")
            
            try:
                return json.loads(extracted)
            except json.JSONDecodeError as e2:
                log(f"Still invalid after extraction: {e2}")
                log(f"Extracted JSON (first 800 chars): {extracted[:800]}")
        
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
            subtitle_section = f"字幕内容：\n{srt_content}"
            subtitle_instruction = "字幕内容已提供，请严格使用提供的字幕内容，不要自己从视频中提取或推测任何对话。"
        else:
            subtitle_section = "字幕内容：无（请从视频中识别对话）"
            subtitle_instruction = "未提供字幕文件，请从视频中分析识别对话内容。"
        
        prompt_text = f"""你是一个专业的视频分析助手。请分析以下视频的剧情和分镜结构。

视频信息：
- 镜头切分结果：
{scene_content}

{subtitle_section}

{subtitle_instruction}

分析要求：
1. 总结整体视频的核心内容，包括故事主题、主要角色关系、关键情节发展
2. 合并细碎镜头为完整剧情分镜，每个分镜时长不超过15秒
3. 识别并合并对话场景中的正反打镜头（角色A说话→角色B反应→角色A说话的连续镜头应合并为一个分镜）
4. 输出全局角色档案，包括：
   - role_id（R1, R2, R3...）
   - 性别、体型、身高特征
   - 永久固定特征（跨画风有效识别特征，如发型、面部特征）
   - 人物差异化标签（不记录临时服装、光线、镜头角度）
   - best_face_time（该人物最佳人脸帧的时间戳，格式为HH:MM:SS.mmm，选择人物面部最清晰、正面、完整的帧）
   - face_position_x（人脸在画面中的水平位置，归一化0-1，0为最左侧，1为最右侧）
   - face_position_y（人脸在画面中的垂直位置，归一化0-1，0为最顶部，1为最底部）
5. 每段分镜输出：
   - 精确起止时间（修改后的）
   - 本段所有出场人物role_id
   - 本段发言人role_id
   - 完整台词字幕（遵循上方字幕规则）
   - 场景描述
   - 光影描述
   - 运镜描述
   - 正向prompt（用于AI生成）
   - 反向prompt（用于排除不想要的元素）

请严格按照以下JSON格式输出，必须包含 video_summary、characters 和 storyboards 三个顶层键：

{{
  "video_summary": "整体视频的核心内容总结，包括故事主题、主要角色关系、关键情节发展",
  "characters": [
    {{
      "role_id": "R1",
      "gender": "男",
      "body_type": "中等身形",
      "height": "中等偏高",
      "permanent_features": "描述",
      "differentiation_labels": ["标签1", "标签2"],
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
      "subtitles": "台词内容",
      "scene_description": "场景描述",
      "lighting_description": "光影描述",
      "camera_movement": "运镜描述",
      "positive_prompt": "AI生成正向prompt",
      "negative_prompt": "AI生成反向prompt"
    }}
  ]
}}

注意：
- start_time、end_time 和 best_face_time 必须使用 HH:MM:SS.mmm 格式
- storyboards 数组不能为空，必须至少包含一个分镜
- characters_present 和 differentiation_labels 必须是数组
- speaker 可以为 null
- best_face_time 必须选择该人物面部最清晰、正面、完整的帧，确保后续可以准确提取人脸
- 不要添加任何额外的顶层键"""
        
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
        
        log("Getting video duration for validation...")
        video_duration = get_video_duration(video_local_path)
        if video_duration:
            log(f"Video duration: {video_duration:.3f}s ({seconds_to_time_str(video_duration)})")
        else:
            log("Warning: Could not determine video duration")
        
        scenes_data = None
        if os.path.exists(scenes_local_path):
            try:
                with open(scenes_local_path, 'r') as f:
                    scenes_data = json.load(f)
                log(f"Loaded {len(scenes_data)} scenes for reference")
            except Exception as e:
                log(f"Warning: Failed to load scenes data: {e}")
        
        log("Validating and fixing storyboard timestamps...")
        result_json = validate_and_fix_storyboards(result_json, video_duration, scenes_data)
        
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