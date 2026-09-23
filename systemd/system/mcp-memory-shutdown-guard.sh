#!/usr/bin/env bash
# MCP Memory Shutdown & Sleep Guard (System-level)
# Waits for any active mcp-memory-review scopes before system powers off, reboots, or sleeps.

MAX_WAIT=300
WAITED=0
TARGET_USER="${1:-nitro}"

while [ $WAITED -lt $MAX_WAIT ]; do
  ACTIVE=$(systemctl --machine="${TARGET_USER}@.host" --user list-units --state=active "mcp-memory-review-*" --no-legend 2>/dev/null | grep -E "mcp-memory-review" || true)
  if [ -z "$ACTIVE" ]; then
    break
  fi

  if [ $WAITED -eq 0 ]; then
    echo "MCP Memory: Session review in progress for ${TARGET_USER}. Holding shutdown/sleep (max 5m)..." > /dev/kmsg 2>/dev/null || true
    echo "MCP Memory: Session review in progress. Holding shutdown/sleep (max 5m)..."
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  echo "MCP Memory: Reached 5-minute timeout. Proceeding with shutdown/sleep." > /dev/kmsg 2>/dev/null || true
fi
exit 0
