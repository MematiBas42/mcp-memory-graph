#!/usr/bin/env bash
# MCP Memory User Session Guard (User-level)
# Prevents user session termination (and killing proxy services) while session review is running.
# If background reviewer was killed on terminal exit, executes fallback review right here in ExecStop.

PENDING_DIR="$HOME/.mcp-memory/pending"
NODE_BIN="/usr/bin/node"
REVIEW_SCRIPT="$HOME/.local/share/mcp-memory-graph/dist/cli/review-and-store.js"

# 1. Clean up any stale pending files older than 30 minutes
if [ -d "$PENDING_DIR" ]; then
  find "$PENDING_DIR" -name "*.json" -mmin +30 -delete 2>/dev/null || true
fi

MAX_WAIT=300
WAITED=0

# 2. Check for active units (backwards-compat)
while [ $WAITED -lt $MAX_WAIT ]; do
  ACTIVE=$(systemctl --user list-units --state=active "mcp-memory-review-*" --no-legend 2>/dev/null | grep -E "mcp-memory-review" || true)
  if [ -z "$ACTIVE" ]; then
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done

# 3. Process any pending review jobs
if [ -d "$PENDING_DIR" ]; then
  for job_file in "$PENDING_DIR"/*.json; do
    [ -f "$job_file" ] || continue

    TRANSCRIPT=$(jq -r '.transcriptPath // empty' "$job_file" 2>/dev/null || true)
    SESSION_ID=$(jq -r '.sessionId // empty' "$job_file" 2>/dev/null || true)
    CWD_DIR=$(jq -r '.cwd // empty' "$job_file" 2>/dev/null || true)

    if [ -z "$TRANSCRIPT" ] || [ -z "$SESSION_ID" ]; then
      rm -f "$job_file"
      continue
    fi

    echo "MCP Memory (User Guard): Session review pending for ${SESSION_ID}. Holding shutdown..." >&2

    # Wait if background review process is currently running
    while pgrep -f "review-and-store\.js.*${SESSION_ID}" >/dev/null 2>&1; do
      sleep 1
      WAITED=$((WAITED + 1))
      if [ $WAITED -ge $MAX_WAIT ]; then
        break
      fi
    done

    # If job file still exists and no background process is running (e.g. killed on terminal close),
    # execute review-and-store directly right here in ExecStop!
    if [ -f "$job_file" ] && [ -f "$REVIEW_SCRIPT" ]; then
      echo "MCP Memory (User Guard): Executing review directly inside ExecStop for ${SESSION_ID}..." >&2
      MCP_MEMORY_CWD="${CWD_DIR:-$HOME}" "$NODE_BIN" "$REVIEW_SCRIPT" "$TRANSCRIPT" "$SESSION_ID" || true
      rm -f "$job_file"
    fi
  done
fi

exit 0
