#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="us-east-1"

echo "=== Phase 3: Face Selection ==="
echo "Task ID: $TASK_ID"
echo "VIDEO_PATH: $VIDEO_PATH"
echo "R2_BUCKET_NAME: $R2_BUCKET_NAME"
echo "R2_ENDPOINT_URL: $R2_ENDPOINT_URL"
echo "R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID:0:10}..."

WORK_DIR="/tmp/$TASK_ID"
echo "WORK_DIR: $WORK_DIR"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"
echo "Current directory after cd: $(pwd)"

LOG_FILE="/tmp/select-faces.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Downloading video from R2..."
echo "Command: aws s3 cp s3://$R2_BUCKET_NAME/$VIDEO_PATH ./input_video.mp4 --endpoint-url $R2_ENDPOINT_URL"
aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL"
echo "Video download completed, checking file..."
ls -la ./input_video.mp4

echo "Downloading scene detection results..."
if aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" "./analysis_result.json" --endpoint-url "$R2_ENDPOINT_URL"; then
    echo "Using AI-analyzed storyboards from analysis_result.json"
elif aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/scenes/scenes.json" "./scenes.json" --endpoint-url "$R2_ENDPOINT_URL"; then
    echo "Using scenes.json from DETECT phase"
else
    echo "Error: Neither analysis_result.json nor scenes.json found"
    exit 1
fi

echo "Running face selection Python script..."

cat > /tmp/face_selection.py << 'PYEOF'
import cv2
import json
import os
import csv
import sys
import subprocess
import traceback
from insightface.app import FaceAnalysis
from sklearn.cluster import DBSCAN
import numpy as np

TASK_ID = os.environ.get('TASK_ID')
R2_ACCESS_KEY_ID = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_ENDPOINT_URL = os.environ.get('R2_ENDPOINT_URL')
R2_BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

WORK_DIR = f'/tmp/{TASK_ID}'

def log(msg):
    print(f"[FACE_SELECTION] {msg}")

def run_command(cmd):
    log(f"Running command: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.stdout:
        log(f"Command output: {result.stdout[:500]}")
    if result.stderr:
        log(f"Command stderr: {result.stderr[:500]}")
    return result.returncode, result.stdout, result.stderr

def upload_to_r2(local_path, target_path, content_type="application/json"):
    log(f"Uploading to R2: {local_path} -> {target_path}")
    cmd = f"aws s3 cp \"{local_path}\" \"s3://{R2_BUCKET_NAME}/{target_path}\" --endpoint-url \"{R2_ENDPOINT_URL}\" --content-type \"{content_type}\""
    returncode, stdout, stderr = run_command(cmd)
    if returncode != 0:
        log(f"Upload failed: {stderr}")
        return False
    return True

def parse_time(t):
    h, m, s = t.split(':')
    s, ms = s.split('.')
    return int(h)*3600 + int(m)*60 + int(s) + int(ms)/1000

def main():
    try:
        log("Starting face selection")
        log(f"TASK_ID: {TASK_ID}")
        log(f"WORK_DIR: {WORK_DIR}")
        
        log(f"List files in work dir: {os.listdir(WORK_DIR)}")
        
        app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=0, det_size=(640, 640))
        log("InsightFace model loaded")

        scenes = []
        analysis_path = os.path.join(WORK_DIR, 'analysis_result.json')
        scenes_json_path = os.path.join(WORK_DIR, 'scenes.json')

        if os.path.exists(analysis_path):
            log(f"Found analysis_result.json, reading...")
            with open(analysis_path, 'r') as f:
                data = json.load(f)
            storyboards = data.get('storyboards', [])
            for i, storyboard in enumerate(storyboards):
                scenes.append({
                    'start': parse_time(storyboard['start_time']),
                    'end': parse_time(storyboard['end_time']),
                    'index': i
                })
            log(f"Loaded {len(scenes)} storyboards from analysis_result.json")
        
        if len(scenes) == 0 and os.path.exists(scenes_json_path):
            log(f"storyboards is empty, falling back to scenes.json...")
            with open(scenes_json_path, 'r') as f:
                data = json.load(f)
            for s in data:
                scenes.append({
                    'start': parse_time(s['start_timecode']),
                    'end': parse_time(s['end_timecode']),
                    'index': s['scene_number'] - 1
                })
            log(f"Loaded {len(scenes)} scenes from scenes.json")
        
        if len(scenes) == 0:
            log(f"Error: No scenes found in analysis_result.json or scenes.json")
            log(f"Files in work dir: {os.listdir(WORK_DIR)}")
            raise FileNotFoundError("No scenes found in analysis_result.json or scenes.json")

        video_path = os.path.join(WORK_DIR, 'input_video.mp4')
        log(f"Video path: {video_path}")
        log(f"Video exists: {os.path.exists(video_path)}")
        
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        log(f"Video FPS: {fps}")
        
        all_faces = []
        
        for scene in scenes:
            duration = scene['end'] - scene['start']
            log(f"Processing scene {scene['index']}: {scene['start']:.3f}s - {scene['end']:.3f}s (duration: {duration:.3f}s)")
            positions = [0.1, 0.5, 0.9]
            
            for pos in positions:
                timestamp = scene['start'] + duration * pos
                frame_num = int(timestamp * fps)
                
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
                ret, frame = cap.read()
                
                if not ret:
                    log(f"Failed to read frame at {timestamp:.3f}s")
                    continue
                
                faces = app.get(frame)
                log(f"Found {len(faces)} faces at {timestamp:.3f}s")
                
                for face in faces:
                    bbox = face.bbox
                    confidence = face.det_score
                    
                    if confidence < 0.8:
                        continue
                    
                    landmarks = face.kps
                    left_eye = landmarks[0]
                    right_eye = landmarks[1]
                    eye_center = (left_eye + right_eye) / 2
                    angle = np.degrees(np.arctan2(right_eye[1]-left_eye[1], right_eye[0]-left_eye[0]))
                    
                    if abs(angle) > 30:
                        continue
                    
                    crop_size = max(bbox[2]-bbox[0], bbox[3]-bbox[1]) * 1.5
                    cx, cy = (bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2
                    x1 = max(0, int(cx - crop_size/2))
                    y1 = max(0, int(cy - crop_size/2))
                    x2 = min(frame.shape[1], int(cx + crop_size/2))
                    y2 = min(frame.shape[0], int(cy + crop_size/2))
                    
                    face_crop = frame[y1:y2, x1:x2]
                    
                    gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
                    blur_score = cv2.Laplacian(gray, cv2.CV_64F).var()
                    
                    frame_path = os.path.join(WORK_DIR, 'face_frames', f"face_{scene['index']}_{int(pos*100)}_{len(all_faces)}.jpg")
                    cv2.imwrite(frame_path, face_crop)
                    
                    all_faces.append({
                        'path': frame_path,
                        'scene_index': scene['index'],
                        'position': pos,
                        'embedding': face.normed_embedding.tolist(),
                        'confidence': confidence,
                        'angle': angle,
                        'blur_score': blur_score
                    })
        
        cap.release()
        log(f"Total faces detected: {len(all_faces)}")
        
        if len(all_faces) == 0:
            log("No faces detected")
            result = {'characters': [], 'faces': [], 'total_faces': 0, 'character_count': 0}
        else:
            embeddings = np.array([f['embedding'] for f in all_faces])
            dbscan = DBSCAN(eps=0.6, min_samples=2, metric='cosine')
            labels = dbscan.fit_predict(embeddings)
            
            characters = []
            for label in np.unique(labels):
                if label == -1:
                    continue
                
                char_faces = [all_faces[i] for i in range(len(all_faces)) if labels[i] == label]
                
                best_face = max(char_faces, key=lambda f: f['confidence'] * (1 - abs(f['angle'])/90) * (f['blur_score']/1000))
                
                character = {
                    'role_id': f'R{len(characters)+1}',
                    'best_frame_path': best_face['path'],
                    'face_count': len(char_faces),
                    'avg_confidence': float(sum(f['confidence'] for f in char_faces) / len(char_faces))
                }
                characters.append(character)
            
            result = {
                'characters': characters,
                'total_faces': len(all_faces),
                'character_count': len(characters)
            }
            log(f"Found {len(characters)} characters from {len(all_faces)} faces")
        
        output_path = os.path.join(WORK_DIR, 'face_selection_result.json')
        with open(output_path, 'w') as f:
            json.dump(result, f, indent=2)
        log(f"Face selection result saved to: {output_path}")
        
        upload_to_r2(output_path, f"{TASK_ID}/face_selection_result.json", "application/json")
        
        for char in result.get('characters', []):
            best_frame = char['best_frame_path']
            role_id = char['role_id']
            if os.path.exists(best_frame):
                upload_to_r2(best_frame, f"{TASK_ID}/character_frames/{role_id}_best.jpg", "image/jpeg")
        
        log("Face selection completed successfully")
        
    except Exception as e:
        error_msg = f"Error in face selection: {e}\nTraceback: {traceback.format_exc()}"
        log(error_msg)
        
        error_log_path = os.path.join(WORK_DIR, 'face_selection_error.log')
        with open(error_log_path, 'w') as f:
            f.write(error_msg)
        
        upload_to_r2(error_log_path, f"{TASK_ID}/face_selection_error.log", "text/plain")
        
        sys.exit(1)

if __name__ == "__main__":
    main()
PYEOF

mkdir -p ./face_frames
echo "Current directory: $(pwd)"
echo "List files before script: $(ls -la)"
echo "Running Python script..."
python3 /tmp/face_selection.py 2>&1 || { echo "Python script failed with exit code $?"; exit 1; }
echo "Python script completed"
echo "List files after script: $(ls -la)"

echo "Phase 3 completed"

RESULT=$(cat ./face_selection_result.json)
cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "characterCount": $(echo "$RESULT" | jq -r '.character_count'),
    "resultPath": "${TASK_ID}/face_selection_result.json"
}
EOF