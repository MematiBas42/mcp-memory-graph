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

while [ $WAITED -lt $MAX_WAIT ]; do
  HAS_PENDING=""
  if [ -d "$PENDING_DIR" ]; then
    HAS_PENDING=$(ls "$PENDING_DIR"/*.json 2>/dev/null | head -n 1 || true)
  fi
  ACTIVE=$(systemctl --machine="${TARGET_USER}@.host" --user list-units --state=active "mcp-memory-review-*" --no-legend 2>/dev/null | grep -E "mcp-memory-review" || true)

  if [ -z "$HAS_PENDING" ] && [ -z "$ACTIVE" ]; then
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
