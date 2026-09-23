#!/usr/bin/env bash
# Installation & management script for mcp-memory-graph systemd integration
# Installs two-tier shutdown guard (system + user) and nightly dream cycle timer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_BIN="$HOME/.local/bin"
USER_SYSTEMD="$HOME/.config/systemd/user"

action="${1:-install}"

install_user_units() {
  echo "==> Installing user-level units..."
  mkdir -p "$USER_BIN" "$USER_SYSTEMD"

  # User guard
  cp "$SCRIPT_DIR/user/mcp-memory-user-guard.sh" "$USER_BIN/mcp-memory-user-guard.sh"
  chmod +x "$USER_BIN/mcp-memory-user-guard.sh"
  cp "$SCRIPT_DIR/user/mcp-memory-user-guard.service" "$USER_SYSTEMD/mcp-memory-user-guard.service"

  # Dream cycle consolidation
  cp "$SCRIPT_DIR/user/mcp-memory-consolidate.service" "$USER_SYSTEMD/mcp-memory-consolidate.service"
  cp "$SCRIPT_DIR/user/mcp-memory-consolidate.timer" "$USER_SYSTEMD/mcp-memory-consolidate.timer"

  systemctl --user daemon-reload
  systemctl --user enable --now mcp-memory-user-guard.service
  systemctl --user enable --now mcp-memory-consolidate.timer
  echo "✔ User units installed and enabled."
}

install_system_units() {
  echo "==> Installing system-level shutdown guard (requires root/pkexec)..."
  local priv="sudo"
  local current_user="${USER:-nitro}"
  if ! command -v sudo >/dev/null 2>&1 && command -v pkexec >/dev/null 2>&1; then
    priv="pkexec"
  fi

  $priv bash -c "
    cp '$SCRIPT_DIR/system/mcp-memory-shutdown-guard.sh' /usr/local/bin/mcp-memory-shutdown-guard.sh
    chmod +x /usr/local/bin/mcp-memory-shutdown-guard.sh
    sed 's/nitro/$current_user/g' '$SCRIPT_DIR/system/mcp-memory-shutdown-guard.service' > /etc/systemd/system/mcp-memory-shutdown-guard.service
    systemctl daemon-reload
    systemctl enable --now mcp-memory-shutdown-guard.service
  "
  echo "✔ System-level shutdown guard installed and enabled."
}

uninstall_all() {
  echo "==> Uninstalling mcp-memory systemd units..."
  systemctl --user disable --now mcp-memory-user-guard.service 2>/dev/null || true
  systemctl --user disable --now mcp-memory-consolidate.timer 2>/dev/null || true
  rm -f "$USER_SYSTEMD/mcp-memory-user-guard.service" \
        "$USER_SYSTEMD/mcp-memory-consolidate.service" \
        "$USER_SYSTEMD/mcp-memory-consolidate.timer" \
        "$USER_BIN/mcp-memory-user-guard.sh"
  systemctl --user daemon-reload

  local priv="sudo"
  if ! command -v sudo >/dev/null 2>&1 && command -v pkexec >/dev/null 2>&1; then
    priv="pkexec"
  fi

  if command -v "$priv" >/dev/null 2>&1; then
    $priv bash -c "
      systemctl disable --now mcp-memory-shutdown-guard.service 2>/dev/null || true
      rm -f /etc/systemd/system/mcp-memory-shutdown-guard.service \
            /usr/local/bin/mcp-memory-shutdown-guard.sh
      systemctl daemon-reload
    "
  fi
  echo "✔ All units removed."
}

case "$action" in
  install)
    install_user_units
    install_system_units
    echo "🎉 MCP Memory systemd integration is fully active!"
    ;;
  user-only)
    install_user_units
    ;;
  uninstall)
    uninstall_all
    ;;
  *)
    echo "Usage: $0 [install|user-only|uninstall]"
    exit 1
    ;;
esac
