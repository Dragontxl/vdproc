#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Running Workflow ==="
echo "Task ID: $TASK_ID"
echo "Start Phase: $START_PHASE"
echo "End Phase: $END_PHASE"
echo "AI_ACCOUNTS raw: $AI_ACCOUNTS"
echo "AI_ACCOUNTS length: ${#AI_ACCOUNTS}"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

LOG_FILE="/tmp/workflow.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

declare -A phase_map=(
  ["DETECT"]=0
  ["ANALYZE"]=1
  ["SELECT_FACES"]=2
  ["GENERATE_CHARACTERS"]=3
  ["CROP_SHOTS"]=4
  ["CONVERT_FRAMES"]=5
  ["GENERATE_SHOTS"]=6
  ["COMPOSE"]=7
)

declare -A phase_api_types=(
  ["DETECT"]=""
  ["ANALYZE"]="text"
  ["SELECT_FACES"]=""
  ["GENERATE_CHARACTERS"]="image"
  ["CROP_SHOTS"]=""
  ["CONVERT_FRAMES"]="image"
  ["GENERATE_SHOTS"]="image"
  ["COMPOSE"]=""
)

phase_scripts=(
  "detect-shots.sh"
  "analyze-scene.sh"
  "select-faces.sh"
  "generate-characters.sh"
  "crop-shots.sh"
  "convert-frames.sh"
  "generate-shots.sh"
  "compose-video.sh"
)

start=${phase_map[$START_PHASE]}
end=${phase_map[$END_PHASE]}

if [ -z "$start" ] || [ -z "$end" ]; then
  echo "Error: Invalid phase specified"
  exit 1
fi

if [ "$start" -gt "$end" ]; then
  echo "Error: Start phase cannot be after end phase"
  exit 1
fi

select_ai_account() {
  local api_type=$1
  local accounts_json=$AI_ACCOUNTS
  
  if [ -z "$accounts_json" ] || [ -z "$api_type" ]; then
    echo "AI_ACCOUNTS not set or no API type needed for this phase"
    return
  fi
  
  echo "select_ai_account: Looking for $api_type accounts..."
  echo "select_ai_account: accounts_json length: ${#accounts_json}"
  echo "select_ai_account: first 200 chars: ${accounts_json:0:200}"
  
  local result=$(echo "$accounts_json" | python3 -c "
import sys, json

try:
    accounts = json.loads(sys.stdin.read())
    print('DEBUG: Loaded', len(accounts), 'accounts')
    
    for acc in accounts:
        print('DEBUG: Account:', acc.get('id'), acc.get('api_type'))
    
    matched = [acc for acc in accounts if acc.get('api_type') == '$api_type']
    print('DEBUG: Found', len(matched), '$api_type accounts')
    
    if matched:
        acc = matched[0]
        key = acc.get('api_key_encrypted', '')
        base_url = acc.get('base_url', '').strip()
        print('KEY:', key)
        print('BASE_URL:', base_url)
    else:
        print('KEY:')
        print('BASE_URL:')
except Exception as e:
    print('ERROR:', str(e))
    print('KEY:')
    print('BASE_URL:')
")
  
  local api_key=$(echo "$result" | grep '^KEY:' | sed 's/^KEY://' | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  local base_url=$(echo "$result" | grep '^BASE_URL:' | sed 's/^BASE_URL://' | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  
  echo "select_ai_account: api_key extracted: ${api_key:0:20}..."
  echo "select_ai_account: base_url extracted: $base_url"
  
  if [ -n "$api_key" ]; then
    export AI_API_KEY="$api_key"
    if [ -n "$base_url" ]; then
      export AI_BASE_URL="$base_url"
    else
      export AI_BASE_URL=""
    fi
    echo "Selected $api_type account, AI_API_KEY set, AI_BASE_URL=${AI_BASE_URL:-empty}"
  else
    echo "No $api_type account found in AI_ACCOUNTS"
    export AI_API_KEY=""
    export AI_BASE_URL=""
  fi
}

report_progress() {
  local phase=$1
  local status=$2
  local message=$3
  
  set +e
  curl -s --connect-timeout 10 --max-time 30 -X POST "$CALLBACK_URL/progress" \
    -H "Content-Type: application/json" \
    -H "X-Callback-Signature: $CALLBACK_SECRET" \
    -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"$phase\",\"status\":\"$status\",\"message\":\"$message\"}" > /dev/null 2>&1
  set -e
}

for i in $(seq $start $end); do
  phase_name="${!phase_map[@]}"
  for key in "${!phase_map[@]}"; do
    if [ "${phase_map[$key]}" -eq "$i" ]; then
      phase_name="$key"
      break
    fi
  done
  
  script_name="${phase_scripts[$i]}"
  
  echo ""
  echo "========================================"
  echo "Running Phase $((i + 1)): $phase_name"
  echo "Script: $script_name"
  echo "========================================"
  
  report_progress "$phase_name" "running" "Starting phase $phase_name"
  
  api_type="${phase_api_types[$phase_name]}"
  select_ai_account "$api_type"
  
  if ! bash "/scripts/$script_name"; then
    echo "ERROR: Phase $phase_name failed"
    report_progress "$phase_name" "failed" "Phase $phase_name failed"
    exit 1
  fi
  
  echo "Phase $phase_name completed successfully"
  report_progress "$phase_name" "completed" "Phase $phase_name completed"
done

echo ""
echo "========================================"
echo "All phases completed successfully"
echo "========================================"

report_progress "WORKFLOW" "completed" "All phases from $START_PHASE to $END_PHASE completed"