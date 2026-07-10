#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Phase 2: Scene Analysis ==="
echo "Task ID: $TASK_ID"
echo "AI Account ID: $AI_ACCOUNT_ID"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/analyze-scene.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

if [ -z "$AI_API_KEY" ]; then
    echo "Error: AI_API_KEY not set"
    exit 1
fi

echo "Downloading video from R2..."
aws s3 cp "s3://$R2_BUCKET_NAME/$VIDEO_PATH" "./input_video.mp4" \
    --endpoint-url "$R2_ENDPOINT_URL"

echo "Downloading scene detection results..."
aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/scenes/scenes.json" "./scenes.json" \
    --endpoint-url "$R2_ENDPOINT_URL" || echo "Warning: scenes.json not found, trying CSV"

if [ -f "./scenes.json" ]; then
    python3 -c "
import json
with open('./scenes.json', 'r') as f:
    data = json.load(f)
for s in data:
    print(f'Shot {s[\"scene_number\"]}: {s[\"start_timecode\"]} -> {s[\"end_timecode\"]} ({s[\"length_seconds\"]}s)')
" > ./scenes.csv
    echo "Parsed scenes.json to scenes.csv"
else
    aws s3 cp "s3://$R2_BUCKET_NAME/${TASK_ID}/scenes/input_video-Scenes.csv" "./scenes.csv" \
        --endpoint-url "$R2_ENDPOINT_URL"
fi

echo "Extracting sample frames for analysis..."
mkdir -p ./analysis_frames
ffmpeg -i ./input_video.mp4 -r 1 -f image2 -q:v 2 "./analysis_frames/frame_%04d.jpg"

echo "Uploading sample frames..."
aws s3 cp ./analysis_frames/ \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_frames/" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --recursive \
    --content-type image/jpeg

echo "Preparing analysis prompt..."
SCENE_CONTENT=$(cat ./scenes.csv)
FRAME_COUNT=$(ls ./analysis_frames/*.jpg 2>/dev/null | wc -l)

ANALYSIS_PROMPT=$(cat <<EOF
你是一个专业的视频分析助手。请分析以下视频的剧情和分镜结构。

视频信息：
- 总时长：需要你分析
- 镜头切分结果：
$SCENE_CONTENT

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

请以JSON格式输出结果。
EOF
)

echo "Calling Gemini API for scene analysis..."

MAX_RETRIES=3
RETRY_DELAY=10
API_SUCCESS=0

for attempt in $(seq 1 $MAX_RETRIES); do
    echo "  Attempt $attempt/$MAX_RETRIES..."
    
    RESPONSE=$(curl -s -X POST \
        --connect-timeout 60 \
        --max-time 300 \
        -w "\n%{http_code}" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $AI_API_KEY" \
        -d "{
            \"model\": \"gemini-2.5-pro\",
            \"contents\": [{
                \"parts\": [{
                    \"text\": \"$ANALYSIS_PROMPT\"
                }]
            }],
            \"generationConfig\": {
                \"temperature\": 0.3,
                \"maxOutputTokens\": 8192
            }
        }" \
        "${AI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent}")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')
    
    echo "  HTTP Status: $HTTP_CODE"
    
    if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
        API_SUCCESS=1
        RESPONSE="$RESPONSE_BODY"
        break
    fi
    
    echo "  Error: $RESPONSE_BODY"
    
    if [ $attempt -lt $MAX_RETRIES ]; then
        sleep $RETRY_DELAY
    fi
done

if [ $API_SUCCESS -ne 1 ]; then
    echo "Error: AI API call failed"
    exit 1
fi

echo "Parsing analysis result..."
echo "$RESPONSE" > ./analysis_result.json

echo "Uploading analysis result..."
aws s3 cp ./analysis_result.json \
    "s3://$R2_BUCKET_NAME/${TASK_ID}/analysis_result.json" \
    --endpoint-url "$R2_ENDPOINT_URL" \
    --content-type application/json

echo "Phase 2 completed: Scene analysis done"

cat > /tmp/result.json <<EOF
{
    "taskId": "$TASK_ID",
    "resultPath": "${TASK_ID}/analysis_result.json"
}
EOF