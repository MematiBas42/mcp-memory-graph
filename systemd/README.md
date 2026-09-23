# MCP Memory Graph — Systemd Integration

This directory contains systemd integration units and scripts providing two critical capabilities for Linux environments:

1. **Two-Tier Shutdown & Sleep Guard**: Prevents data loss or truncated session analyses by delaying system poweroff, reboot, or suspend while a Claude Code session review (`review-and-store.js`) is active.
2. **Nightly Dream Cycle Consolidation**: Runs automated memory consolidation and pruning at 04:00 AM every night.

---

## Architecture Overview

```text
               [ Poweroff / Reboot / Sleep Triggered ]
                                  │
          ┌───────────────────────┴───────────────────────┐
          ▼                                               ▼
  [ User Level (systemd --user) ]               [ System Level (PID 1) ]
  mcp-memory-user-guard.service                 mcp-memory-shutdown-guard.service
  ├── Before: exit.target, shutdown.target      ├── Before: poweroff.target, sleep.target
  └── After: cliproxyapi, token-proxy           └── After: NetworkManager, network.target
          │                                               │
          ▼                                               ▼
  Holds user session & prevents killing         Holds system poweroff & prevents killing
  local LLM proxy daemons                       Wi-Fi, Ethernet, DNS, and network stack
          │                                               │
          └───────────────────────┬───────────────────────┘
                                  ▼
               Checks Pending Queue (`~/.mcp-memory/pending/`)
               Waits for active reviews OR executes fallback
               directly inside ExecStop (typically 5-10s, max 300s)
                                  │
                                  ▼
                  Review Completes & Clears Queue
                                  │
                                  ▼
                     System Shuts Down Cleanly
```

---

## Directory Structure

```text
systemd/
├── system/
│   ├── mcp-memory-shutdown-guard.service   # System-level poweroff/reboot/sleep guard
│   └── mcp-memory-shutdown-guard.sh        # System guard monitor script
├── user/
│   ├── mcp-memory-user-guard.service       # User-level session exit guard
│   ├── mcp-memory-user-guard.sh            # User guard monitor script
│   ├── mcp-memory-consolidate.service     # Nightly dream cycle service
│   └── mcp-memory-consolidate.timer       # Nightly timer (04:00 AM)
├── install.sh                              # Automated installer script
└── README.md                               # This documentation
```

---

## Installation

### Full Installation (Recommended)
Installs both user-level guards/timers and system-level network/poweroff guards:

```bash
./systemd/install.sh
```

### User-Only Installation (No Root)
Installs only user-space session guards and the dream cycle timer:

```bash
./systemd/install.sh user-only
```

### Uninstallation
```bash
./systemd/install.sh uninstall
```
