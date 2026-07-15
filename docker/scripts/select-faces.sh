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

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/select-faces.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

report_progress() {
    local processed=$1
    local total=$2
    local message=$3
    echo "Reporting progress: $message"
    set +e
    curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/progress" \
        -H "Content-Type: application/json" \
        -H "X-Callback-Signature: $CALLBACK_SECRET" \
        -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"SELECT_FACES\",\"processed_count\":$processed,\"total_count\":$total,\"message\":\"$message\"}" > /dev/null 2>&1
    set -e
}

MAX_ROUNDS=3

for round in $(seq 1 $MAX_ROUNDS); do
    echo "=== Round $round/$MAX_ROUNDS ==="
    
    echo "Downloading video from R2..."
    aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
        --endpoint-url "$R2_ENDPOINT_URL"

    echo "Downloading scene detection results..."
    if aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" "./analysis_result.json" --endpoint-url "$R2_ENDPOINT_URL"; then
        echo "Using AI-analyzed storyboards from analysis_result.json"
    elif aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/scenes/scenes.json" "./scenes.json" --endpoint-url "$R2_ENDPOINT_URL"; then
        echo "Using scenes.json from DETECT phase"
    else
        echo "Error: Neither analysis_result.json nor scenes.json found"
        if [ "$round" -lt "$MAX_ROUNDS" ]; then
            echo "Round $round failed, retrying..."
            sleep 5
            continue
        else
            exit 1
        fi
    fi

    echo "Running face selection Python script..."

    cat > /tmp/face_selection.py << 'PYEOF'
import cv2
import json
import os
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
        
        os.makedirs(os.path.join(WORK_DIR, 'face_frames'), exist_ok=True)
        os.makedirs(os.path.join(WORK_DIR, 'scene_frames'), exist_ok=True)
        
        app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=0, det_size=(640, 640))
        log("InsightFace model loaded")

        scenes = []
        analysis_path = os.path.join(WORK_DIR, 'analysis_result.json')
        scenes_json_path = os.path.join(WORK_DIR, 'scenes.json')

        analysis_characters = {}
        if os.path.exists(analysis_path):
            log(f"Found analysis_result.json, reading...")
            with open(analysis_path, 'r') as f:
                data = json.load(f)
            for i, storyboard in enumerate(data.get('storyboards', [])):
                scenes.append({
                    'start': parse_time(storyboard['start_time']),
                    'end': parse_time(storyboard['end_time']),
                    'index': i
                })
            for char in data.get('characters', []):
                role_id = char.get('role_id', '')
                if role_id:
                    analysis_characters[role_id] = {
                        'permanent_features': char.get('permanent_features', ''),
                        'differentiation_labels': char.get('differentiation_labels', [])
                    }
            log(f"Loaded {len(scenes)} storyboards and {len(analysis_characters)} character descriptions from analysis_result.json")
        elif os.path.exists(scenes_json_path):
            log(f"Found scenes.json, reading...")
            with open(scenes_json_path, 'r') as f:
                data = json.load(f)
            for s in data:
                scenes.append({
                    'start': parse_time(s['start_timecode']),
                    'end': parse_time(s['end_timecode']),
                    'index': s['scene_number'] - 1
                })
            log(f"Loaded {len(scenes)} scenes from scenes.json")
        else:
            log(f"Error: Neither analysis_result.json nor scenes.json found")
            raise FileNotFoundError("Neither analysis_result.json nor scenes.json found")

        video_path = os.path.join(WORK_DIR, 'input_video.mp4')
        log(f"Video path: {video_path}")
        
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        log(f"Video FPS: {fps}")
        
        all_faces = []
        saved_scene_frames = []
        
        scene_face_count = {}
        scene_expected_chars = {}
        for scene in scenes:
            scene_face_count[scene['index']] = 0
            scene_expected_chars[scene['index']] = 0
        
        if os.path.exists(analysis_path):
            with open(analysis_path, 'r') as f:
                analysis_data = json.load(f)
            for scene_idx, sb in enumerate(analysis_data.get('storyboards', [])):
                scene_expected_chars[scene_idx] = len(sb.get('characters_present', []))
        
        for scene in scenes:
            duration = scene['end'] - scene['start']
            log(f"Processing scene {scene['index']}: {scene['start']:.3f}s - {scene['end']:.3f}s (duration: {duration:.3f}s)")
            positions = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
            
            for pos in positions:
                expected_count = scene_expected_chars.get(scene['index'], 0)
                current_count = scene_face_count.get(scene['index'], 0)
                if expected_count > 0 and current_count >= expected_count * 3:
                    log(f"  Found {current_count} faces for {expected_count} expected characters, skipping remaining frames")
                    break
                
                timestamp = scene['start'] + duration * pos
                frame_num = int(timestamp * fps)
                
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
                ret, frame = cap.read()
                
                if not ret:
                    log(f"Failed to read frame at {timestamp:.3f}s")
                    continue
                
                scene_frame_path = os.path.join(WORK_DIR, 'scene_frames', f"scene_{scene['index']}_{int(pos*100)}.jpg")
                cv2.imwrite(scene_frame_path, frame)
                saved_scene_frames.append({
                    'local_path': scene_frame_path,
                    'scene_index': scene['index'],
                    'position': pos,
                    'timestamp': timestamp
                })
                
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
                    angle = np.degrees(np.arctan2(right_eye[1]-left_eye[1], right_eye[0]-left_eye[0]))
                    
                    if abs(angle) > 45:
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
                        'timestamp': timestamp,
                        'embedding': face.normed_embedding.tolist(),
                        'confidence': float(confidence),
                        'angle': float(angle),
                        'blur_score': float(blur_score)
                    })
                    scene_face_count[scene['index']] += 1
    
        cap.release()
        log(f"Total faces detected: {len(all_faces)}")
        
        if len(all_faces) == 0:
            log("No faces detected")
            result = {'characters': [], 'faces': [], 'total_faces': 0, 'character_count': 0, 'scene_frames': []}
        else:
            analysis_char_list = []
            char_to_scenes = {}
            if analysis_path and os.path.exists(analysis_path):
                with open(analysis_path, 'r') as f:
                    analysis_data = json.load(f)
                for char in analysis_data.get('characters', []):
                    analysis_char_list.append(char.get('role_id', ''))
                for scene_idx, sb in enumerate(analysis_data.get('storyboards', [])):
                    for char_id in sb.get('characters_present', []):
                        if char_id not in char_to_scenes:
                            char_to_scenes[char_id] = set()
                        char_to_scenes[char_id].add(scene_idx)
            log(f"Analysis characters: {analysis_char_list}")
            log(f"Character to scenes mapping: {char_to_scenes}")
            
            if analysis_char_list:
                embeddings = np.array([f['embedding'] for f in all_faces])
                
                char_anchors = {}
                for role_id in analysis_char_list:
                    char_anchors[role_id] = []
                
                for sb_idx, sb in enumerate(analysis_data.get('storyboards', [])):
                    chars_in_scene = sb.get('characters_present', [])
                    if len(chars_in_scene) == 1:
                        role_id = chars_in_scene[0]
                        for i, face in enumerate(all_faces):
                            if face['scene_index'] == sb_idx:
                                char_anchors[role_id].append(i)
                
                log(f"Anchor faces per character: {dict((k, len(v)) for k, v in char_anchors.items())}")
                
                char_faces = {}
                for role_id in analysis_char_list:
                    char_faces[role_id] = []
                
                unassigned_indices = set(range(len(all_faces)))
                
                if sum(len(anchors) for anchors in char_anchors.values()) > 0:
                    anchor_indices = []
                    anchor_char_ids = []
                    for role_id, indices in char_anchors.items():
                        for idx in indices:
                            anchor_indices.append(idx)
                            anchor_char_ids.append(role_id)
                    
                    anchor_embeddings = embeddings[anchor_indices]
                    
                    for i in range(len(all_faces)):
                        if i in anchor_indices:
                            continue
                        
                        face_embedding = embeddings[i]
                        similarities = np.dot(anchor_embeddings, face_embedding)
                        max_sim_idx = np.argmax(similarities)
                        max_sim = similarities[max_sim_idx]
                        best_role = anchor_char_ids[max_sim_idx]
                        
                        face_scene = all_faces[i]['scene_index']
                        scene_chars = set()
                        if face_scene < len(analysis_data.get('storyboards', [])):
                            scene_chars = set(analysis_data['storyboards'][face_scene].get('characters_present', []))
                        
                        if max_sim > 0.7:
                            char_faces[best_role].append(all_faces[i])
                            unassigned_indices.discard(i)
                            log(f"  Face {i} (scene {face_scene}, time {all_faces[i]['timestamp']:.3f}s) assigned to {best_role} (similarity: {max_sim:.2f})")
                        elif max_sim > 0.5 and len(scene_chars) == 1:
                            for char_id in scene_chars:
                                char_faces[char_id].append(all_faces[i])
                                unassigned_indices.discard(i)
                                log(f"  Face {i} (scene {face_scene}, time {all_faces[i]['timestamp']:.3f}s) assigned to {char_id} (scene-only)")
                                break
                    
                    for role_id, indices in char_anchors.items():
                        for idx in indices:
                            char_faces[role_id].append(all_faces[idx])
                            unassigned_indices.discard(idx)
                            log(f"  Anchor face {idx} (scene {all_faces[idx]['scene_index']}) assigned to {role_id}")
                else:
                    log("No anchor faces found, using DBSCAN clustering")
                    n_faces = len(all_faces)
                    eps = 0.45 if n_faces < 10 else 0.5
                    min_samples = max(2, int(n_faces * 0.05))
                    dbscan = DBSCAN(eps=eps, min_samples=min_samples, metric='cosine')
                    labels = dbscan.fit_predict(embeddings)
                    
                    clusters = {}
                    for label in np.unique(labels):
                        if label == -1:
                            continue
                        clusters[label] = [all_faces[i] for i in range(len(all_faces)) if labels[i] == label]
                    
                    sorted_clusters = sorted(clusters.items(), key=lambda x: len(x[1]), reverse=True)
                    
                    for idx, (label, faces) in enumerate(sorted_clusters):
                        if idx < len(analysis_char_list):
                            role_id = analysis_char_list[idx]
                            char_faces[role_id] = faces
                            log(f"  Cluster {label} ({len(faces)} faces) assigned to {role_id}")
                
                if unassigned_indices:
                    log(f"  {len(unassigned_indices)} unassigned faces, distributing to characters with target scenes")
                    expected_total = len(analysis_char_list)
                    actual_total = len(all_faces)
                    
                    has_background = actual_total > expected_total * 2
                    
                    for i in unassigned_indices:
                        face = all_faces[i]
                        best_role = None
                        best_score = 0
                        for role_id in analysis_char_list:
                            target_scenes = char_to_scenes.get(role_id, set())
                            if face['scene_index'] in target_scenes:
                                score = 0
                                if len(char_faces[role_id]) == 0:
                                    score += 20
                                elif has_background and len(char_faces[role_id]) < len(all_faces) // expected_total:
                                    score += 15
                                elif len(char_faces[role_id]) < len(all_faces) // expected_total:
                                    score += 5
                                score += len(target_scenes)
                                if score > best_score:
                                    best_score = score
                                    best_role = role_id
                        if best_role:
                            char_faces[best_role].append(face)
                            log(f"  Unassigned face {i} assigned to {best_role} (score: {best_score})")
                
                characters = []
                for role_id in analysis_char_list:
                    faces = char_faces.get(role_id, [])
                    if faces:
                        best_face = max(faces, key=lambda f: float(f['confidence']) * (1 - abs(float(f['angle']))/90) * (min(float(f['blur_score']), 2000)/2000))
                        log(f"Character {role_id}: {len(faces)} faces, best at scene {best_face['scene_index']}, time {best_face['timestamp']:.3f}s")
                        characters.append({
                            'role_id': role_id,
                            'best_frame_path': best_face['path'],
                            'face_count': len(faces),
                            'avg_confidence': float(sum(float(f['confidence']) for f in faces) / len(faces))
                        })
                    else:
                        log(f"Character {role_id}: no faces found, using fallback")
                        target_scenes = char_to_scenes.get(role_id, set())
                        candidate_faces = [f for f in all_faces if f['scene_index'] in target_scenes]
                        if candidate_faces:
                            fallback_face = max(candidate_faces, key=lambda f: float(f['confidence']) * (1 - abs(float(f['angle']))/90) * (min(float(f['blur_score']), 2000)/2000))
                        else:
                            fallback_face = max(all_faces, key=lambda f: float(f['confidence']) * (1 - abs(float(f['angle']))/90) * (min(float(f['blur_score']), 2000)/2000))
                        characters.append({
                            'role_id': role_id,
                            'best_frame_path': fallback_face['path'],
                            'face_count': 1,
                            'avg_confidence': float(fallback_face['confidence'])
                        })
            else:
                n_faces = len(all_faces)
                if n_faces < 10:
                    eps = 0.45
                elif n_faces < 30:
                    eps = 0.5
                else:
                    eps = 0.55
                
                embeddings = np.array([f['embedding'] for f in all_faces])
                min_samples = max(2, int(n_faces * 0.05))
                dbscan = DBSCAN(eps=eps, min_samples=min_samples, metric='cosine')
                labels = dbscan.fit_predict(embeddings)
                
                characters = []
                for label in np.unique(labels):
                    if label == -1:
                        continue
                    char_faces = [all_faces[i] for i in range(len(all_faces)) if labels[i] == label]
                    best_face = max(char_faces, key=lambda f: float(f['confidence']) * (1 - abs(float(f['angle']))/90) * (min(float(f['blur_score']), 2000)/2000))
                    characters.append({
                        'role_id': f'R{len(characters)+1}',
                        'best_frame_path': best_face['path'],
                        'face_count': len(char_faces),
                        'avg_confidence': float(sum(float(f['confidence']) for f in char_faces) / len(char_faces))
                    })
            
            result = {
                'characters': characters,
                'total_faces': len(all_faces),
                'character_count': len(characters),
                'scene_frame_count': len(saved_scene_frames)
            }
            log(f"Found {len(characters)} characters from {len(all_faces)} faces, saved {len(saved_scene_frames)} scene frames")
        
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
        
        for sf in saved_scene_frames:
            if os.path.exists(sf['local_path']):
                r2_path = f"{TASK_ID}/scene_frames/scene_{sf['scene_index']}_{int(sf['position']*100)}.jpg"
                upload_to_r2(sf['local_path'], r2_path, "image/jpeg")
        
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

    python3 /tmp/face_selection.py 2>&1
    if [ $? -eq 0 ]; then
        echo "Face selection succeeded at round $round"
        break
    else
        echo "Face selection failed at round $round"
        if [ "$round" -lt "$MAX_ROUNDS" ]; then
            echo "Retrying in 10 seconds..."
            sleep 10
        else
            echo "Failed after $MAX_ROUNDS rounds"
            exit 1
        fi
    fi
done

echo "Phase 3 completed"

RESULT=$(cat ./face_selection_result.json)
CHARACTER_COUNT=$(echo "$RESULT" | jq -r '.character_count')
report_progress "$CHARACTER_COUNT" "$CHARACTER_COUNT" "最优帧选择完成，识别到 $CHARACTER_COUNT 个角色"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "characterCount": $CHARACTER_COUNT,
    "resultPath": "${TASK_ID}/face_selection_result.json"
}
EOF
