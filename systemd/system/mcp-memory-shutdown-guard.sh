#!/usr/bin/env bash
# MCP Memory Shutdown & Sleep Guard (System-level)
# Waits for any pending reviews or active review units before system powers off, reboots, or sleeps.

MAX_WAIT=300
WAITED=0
TARGET_USER="${1:-nitro}"
TARGET_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
PENDING_DIR="$TARGET_HOME/.mcp-memory/pending"

# Clean up stale pending files older than 30 minutes
if [ -d "$PENDING_DIR" ]; then
  find "$PENDING_DIR" -name "*.json" -mmin +30 -delete 2>/dev/null || true
fi

is_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -zq "review-and-store" "/proc/$pid/cmdline" 2>/dev/null
}

while [ $WAITED -lt $MAX_WAIT ]; do
  HAS_LIVE_JOB=0
  if [ -d "$PENDING_DIR" ]; then
    for job_file in "$PENDING_DIR"/*.json; do
      [ -f "$job_file" ] || continue
      pid=$(jq -r '.pid // empty' "$job_file" 2>/dev/null || true)
      attempts=$(jq -r '.attempts // 0' "$job_file" 2>/dev/null || echo 0)

      if is_running "$pid"; then
        HAS_LIVE_JOB=1
      elif [ "${attempts:-0}" -ge 1 ]; then
        # Process has finished or died; remove stale job file
        rm -f "$job_file"
      fi
    done
  fi

  ACTIVE=$(systemctl --machine="${TARGET_USER}@.host" --user list-units --state=active "mcp-memory-review-*" --no-legend 2>/dev/null | grep -E "mcp-memory-review" || true)

  if [ "$HAS_LIVE_JOB" -eq 0 ] && [ -z "$ACTIVE" ]; then
    break
  fi

  if [ $WAITED -eq 0 ]; then
    (echo "MCP Memory: Session review pending for ${TARGET_USER}. Holding shutdown/sleep (max 5m)..." > /dev/kmsg) 2>/dev/null || true
    echo "MCP Memory: Session review pending for ${TARGET_USER}. Holding shutdown/sleep (max 5m)..."
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  (echo "MCP Memory: Reached 5-minute timeout. Proceeding with shutdown/sleep." > /dev/kmsg) 2>/dev/null || true
fi
exit 0
