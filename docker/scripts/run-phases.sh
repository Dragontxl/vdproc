#!/bin/bash
set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

echo "=== Range Execution Environment ==="
echo "TASK_ID: $TASK_ID"
echo "START_PHASE: $START_PHASE"
echo "END_PHASE: $END_PHASE"
echo "AI_API_KEY: ${AI_API_KEY:0:20}..."
echo "AI_BASE_URL: $AI_BASE_URL"
echo "AI_ACCOUNTS length: ${#AI_ACCOUNTS}"
echo "PROMPT: ${PROMPT:0:50}..."
echo "MAX_CONCURRENT: $MAX_CONCURRENT"
echo "CALLBACK_URL: $CALLBACK_URL"

notify_phase() {
  local phase="$1"
  local status="$2"
  local processed="${3:-0}"
  local total="${4:-0}"
  
  if [ -z "$CALLBACK_URL" ] || [ -z "$CALLBACK_SECRET" ]; then
    echo "Warning: CALLBACK_URL or CALLBACK_SECRET not set, skipping notification"
    return
  fi
  
  echo "Notifying phase $phase status=$status processed=$processed total=$total"
  
  local max_retries=3
  local retry_delay=5
  
  for attempt in $(seq 1 $max_retries); do
    local response=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X POST "$CALLBACK_URL/progress" \
      -H "Content-Type: application/json" \
      -H "X-Callback-Signature: $CALLBACK_SECRET" \
      -d "{\"task_id\":\"$TASK_ID\",\"phase\":\"$phase\",\"processed_count\":$processed,\"total_count\":$total,\"message\":\"$phase phase $status\"}")
    
    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | head -n -1)
    
    echo "Callback attempt $attempt: HTTP=$http_code, body=$body"
    
    if [ "$http_code" -eq 200 ]; then
      echo "Phase $phase notification successful"
      return 0
    fi
    
    if [ "$attempt" -lt "$max_retries" ]; then
      sleep $retry_delay
    fi
  done
  
  echo "Warning: Failed to notify phase $phase after $max_retries attempts"
  return 1
}

PHASES=("DETECT" "ANALYZE" "CROP_SHOTS" "CONVERT_FRAMES" "GENERATE_SHOTS" "COMPOSE")
PHASE_SCRIPTS=(
  "/scripts/detect-shots.sh"
  "/scripts/analyze-scene.sh"
  "/scripts/crop-shots.sh"
  "/scripts/convert-frames.sh"
  "/scripts/generate-shots.sh"
  "/scripts/compose-video.sh"
)

START_PHASE="${START_PHASE:-DETECT}"
END_PHASE="${END_PHASE:-COMPOSE}"

start_idx=-1
end_idx=-1

for i in "${!PHASES[@]}"; do
  if [ "${PHASES[$i]}" = "$START_PHASE" ]; then
    start_idx=$i
  fi
  if [ "${PHASES[$i]}" = "$END_PHASE" ]; then
    end_idx=$i
  fi
done

if [ $start_idx -eq -1 ]; then
  echo "Error: Start phase '$START_PHASE' not found"
  exit 1
fi

if [ $end_idx -eq -1 ]; then
  echo "Error: End phase '$END_PHASE' not found"
  exit 1
fi

if [ $start_idx -gt $end_idx ]; then
  echo "Error: Start phase must be before end phase"
  exit 1
fi

echo "=== Range Execution: $START_PHASE to $END_PHASE ==="
echo "Total phases to execute: $((end_idx - start_idx + 1))"

for ((i=start_idx; i<=end_idx; i++)); do
  phase="${PHASES[$i]}"
  script="${PHASE_SCRIPTS[$i]}"
  
  echo "========================================"
  echo "=== Executing phase $((i+1))/${#PHASES[@]}: $phase ==="
  echo "========================================"
  
  notify_phase "$phase" "started" 0 0
  
  bash "$script"
  script_exit_code=$?
  
  if [ $script_exit_code -ne 0 ]; then
    echo "ERROR: Phase $phase failed with exit code $script_exit_code"
    notify_phase "$phase" "failed" 0 0
    exit 1
  fi
  
  echo "=== Phase $phase completed successfully ==="
  notify_phase "$phase" "completed" 1 1
done

echo "========================================"
echo "=== All phases completed successfully ==="
echo "========================================"