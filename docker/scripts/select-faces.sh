#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 3: Face Selection ==="
echo "Task ID: $TASK_ID"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/select-faces.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

echo "Downloading video from R2..."
aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Downloading scene detection results..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/scenes/scenes.csv" "./scenes.csv" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Running face selection Python script..."

cat > /tmp/face_selection.py << 'PYEOF'
import cv2
import json
import os
import csv
from insightface.app import FaceAnalysis
from sklearn.cluster import DBSCAN
import numpy as np

app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=0, det_size=(640, 640))

scenes = []
with open('/tmp/'+os.environ['TASK_ID']+'/scenes.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        time_range = row['Timecode']
        start_str, end_str = time_range.split(' --> ')
        
        def parse_time(t):
            h, m, s = t.split(':')
            s, ms = s.split('.')
            return int(h)*3600 + int(m)*60 + int(s) + int(ms)/1000
        
        scenes.append({
            'start': parse_time(start_str),
            'end': parse_time(end_str),
            'index': len(scenes)
        })

video_path = '/tmp/'+os.environ['TASK_ID']+'/input_video.mp4'
cap = cv2.VideoCapture(video_path)
fps = cap.get(cv2.CAP_PROP_FPS)

all_faces = []

for scene in scenes:
    duration = scene['end'] - scene['start']
    positions = [0.1, 0.5, 0.9]
    
    for pos in positions:
        timestamp = scene['start'] + duration * pos
        frame_num = int(timestamp * fps)
        
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
        ret, frame = cap.read()
        
        if not ret:
            continue
        
        faces = app.get(frame)
        
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
            
            frame_path = f"/tmp/{os.environ['TASK_ID']}/face_frames/face_{scene['index']}_{int(pos*100)}_{len(all_faces)}.jpg"
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

if len(all_faces) == 0:
    print("No faces detected")
    with open('/tmp/'+os.environ['TASK_ID']+'/face_selection_result.json', 'w') as f:
        json.dump({'characters': [], 'faces': []}, f)
    exit(0)

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
        'avg_confidence': sum(f['confidence'] for f in char_faces) / len(char_faces)
    }
    characters.append(character)

result = {
    'characters': characters,
    'total_faces': len(all_faces),
    'character_count': len(characters)
}

with open('/tmp/'+os.environ['TASK_ID']+'/face_selection_result.json', 'w') as f:
    json.dump(result, f, indent=2)

print(f"Found {len(characters)} characters from {len(all_faces)} faces")
PYEOF

mkdir -p ./face_frames
python3 /tmp/face_selection.py

echo "Uploading face selection result..."
aws s3 cp ./face_selection_result.json \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/face_selection_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --content-type application/json

echo "Uploading best face frames..."
RESULT=$(cat ./face_selection_result.json)
ROLE_COUNT=$(echo "$RESULT" | jq -r '.characters | length')

for i in $(seq 0 $((ROLE_COUNT - 1))); do
    ROLE_ID=$(echo "$RESULT" | jq -r ".characters[$i].role_id")
    BEST_FRAME=$(echo "$RESULT" | jq -r ".characters[$i].best_frame_path")
    FRAME_NAME=$(basename "$BEST_FRAME")
    
    aws s3 cp "$BEST_FRAME" \
        "s3://$R2_BUCKET_NAME/${TASK_ID}/character_frames/${ROLE_ID}_best.jpg" \
        --endpoint-url "$R2_ENDPOINT_URL" \
        --content-type image/jpeg
done

echo "Phase 3 completed"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "characterCount": $(echo "$RESULT" | jq -r '.character_count'),
    "resultPath": "${TASK_ID}/face_selection_result.json"
}
EOF