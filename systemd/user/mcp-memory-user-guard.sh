#!/usr/bin/env bash
# MCP Memory User Session Guard (User-level)
# Prevents user session termination (and killing proxy services) while session review is running.

MAX_WAIT=300
WAITED=0

while [ $WAITED -lt $MAX_WAIT ]; do
  ACTIVE=$(systemctl --user list-units --state=active "mcp-memory-review-*" --no-legend 2>/dev/null | grep -E "mcp-memory-review" || true)
  if [ -z "$ACTIVE" ]; then
    break
  fi

  if [ $WAITED -eq 0 ]; then
    echo "MCP Memory (User Guard): Session review in progress. Holding user session and proxy services (max 5m)..." >&2
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

exit 0
