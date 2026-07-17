#!/bin/bash
set -e

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

WORK_DIR="/tmp/$TASK_ID"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

PHASES=("DETECT" "ANALYZE" "SELECT_FACES" "GENERATE_CHARACTERS" "CROP_SHOTS" "CONVERT_FRAMES" "GENERATE_SHOTS" "COMPOSE")
PHASE_SCRIPTS=(
  "/scripts/detect-shots.sh"
  "/scripts/analyze-scene.sh"
  "/scripts/select-faces.sh"
  "/scripts/generate-characters.sh"
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
  
  bash "$script"
  
  if [ $? -ne 0 ]; then
    echo "ERROR: Phase $phase failed"
    exit 1
  fi
  
  echo "=== Phase $phase completed successfully ==="
done

echo "========================================"
echo "=== All phases completed successfully ==="
echo "========================================"