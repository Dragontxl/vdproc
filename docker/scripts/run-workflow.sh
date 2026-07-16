#!/bin/bash

set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

echo "=== Running Workflow ==="
echo "Task ID: $TASK_ID"
echo "Start Phase: $START_PHASE"
echo "End Phase: $END_PHASE"

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