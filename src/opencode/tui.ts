import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ID = "mcp-memory-graph.status";

interface MemoryStats {
  ok: boolean;
  memories: number | string;
  entities: number;
}

interface MemoryItem {
  id: string;
  title: string;
  snippet: string;
  importance_score: number | null;
  calledAt?: string;
}

interface SessionState {
  enabled: boolean;
  mutedIds: string[];
  lastRecall?: {
    ts: string;
    tokens: string[];
    matches: MemoryItem[];
  };
  history: MemoryItem[];
}

function getSessionStatePath(sessionId: string): string {
  const dir = join(homedir(), ".mcp-memory", "sessions");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // safe ignore
    }
  }
  const safeId = (sessionId || "global").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(dir, `${safeId}.json`);
}

function readSessionState(sessionId: string): SessionState {
  try {
    const p = getSessionStatePath(sessionId);
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      return {
        enabled: data.enabled !== false,
        mutedIds: Array.isArray(data.mutedIds) ? data.mutedIds : [],
        lastRecall: data.lastRecall,
        history: Array.isArray(data.history) ? data.history : [],
      };
    }
  } catch {
    // safe ignore
  }
  return { enabled: true, mutedIds: [], history: [] };
}

function saveSessionState(sessionId: string, state: SessionState): void {
  try {
    const p = getSessionStatePath(sessionId);
    writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // safe ignore
  }
}

function toggleSessionMemory(sessionId: string): boolean {
  const state = readSessionState(sessionId);
  state.enabled = !state.enabled;
  saveSessionState(sessionId, state);
  return state.enabled;
}

function toggleMemoryMute(sessionId: string, memoryId: string): boolean {
  const state = readSessionState(sessionId);
  if (!Array.isArray(state.mutedIds)) state.mutedIds = [];
  const idx = state.mutedIds.indexOf(memoryId);
  let nowMuted = false;
  if (idx !== -1) {
    state.mutedIds.splice(idx, 1);
    nowMuted = false;
  } else {
    state.mutedIds.push(memoryId);
    nowMuted = true;
  }
  saveSessionState(sessionId, state);
  return nowMuted;
}

// Global cached stats to avoid any async latency or layout shifts
let cachedStats: MemoryStats = { ok: true, memories: 0, entities: 0 };
let isFetchingStats = false;

async function fetchStatsAsync(): Promise<MemoryStats> {
  if (isFetchingStats) return cachedStats;
  isFetchingStats = true;
  try {
    const res = await fetch("http://127.0.0.1:3100/api/stats", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      cachedStats = {
        ok: true,
        memories: data.total_memories ?? 0,
        entities: Object.keys(data.by_document_type ?? {}).length,
      };
      return cachedStats;
    }
  } catch {
    // REST server fallback
  } finally {
    isFetchingStats = false;
  }

  try {
    const { execFile } = await import("node:child_process");
    const dbPath = process.env.MCP_MEMORY_DB_PATH || `${process.env.HOME}/.mcp-memory/memory.db`;
    return await new Promise<MemoryStats>((resolve) => {
      execFile(
        "sqlite3",
        [
          dbPath,
          "SELECT COUNT(*) FROM memories WHERE parent_id IS NULL AND superseded_at IS NULL AND tx_expired IS NULL",
        ],
        { timeout: 2000 },
        (err, stdout) => {
          if (!err && stdout) {
            const num = parseInt(stdout.trim(), 10);
            if (!isNaN(num)) {
              cachedStats = { ok: true, memories: num, entities: 0 };
              resolve(cachedStats);
              return;
            }
          }
          resolve(cachedStats);
        },
      );
    });
  } catch {
    return cachedStats;
  }
}

function safeAdd(parent: any, child: any): void {
  if (!parent || !child) return;
  if (typeof parent.add === "function") {
    parent.add(child);
  } else if (typeof parent.appendChild === "function") {
    parent.appendChild(child);
  }
}

function safeRemove(parent: any, child: any): void {
  if (!parent || !child) return;
  if (typeof parent.remove === "function") {
    parent.remove(child);
  } else if (typeof parent.removeChild === "function") {
    parent.removeChild(child);
  }
}

function safeClear(parent: any): void {
  if (!parent) return;
  const children = typeof parent.getChildren === "function" ? [...parent.getChildren()] : [];
  for (const c of children) {
    safeRemove(parent, c);
  }
}

// Module-level accordion state map
interface AccordionState {
  main: boolean;
  lastRecall: boolean;
  history: boolean;
}

const sessionAccordionMap = new Map<string, AccordionState>();

function getAccordionState(sessionId: string): AccordionState {
  let state = sessionAccordionMap.get(sessionId);
  if (!state) {
    state = {
      main: true,
      lastRecall: true,
      history: true,
    };
    sessionAccordionMap.set(sessionId, state);
  }
  return state;
}

function createMemoryPromptStatus(api: any, solid: any, sessionData?: any) {
  const sessionId = () => sessionData?.session_id || "global";
  const [sessionState, setSessionState] = solid.createSignal(readSessionState(sessionId()));

  const refreshPrompt = () => {
    setSessionState(readSessionState(sessionId()));
  };

  refreshPrompt();

  // 100% Event-driven lifecycle triggers (zero polling / no setInterval)
  const disposeMessage = api.event?.on?.("message.updated", (e: any) => {
    if (e.properties?.info?.time?.completed) {
      refreshPrompt();
    }
  });
  const disposeIdle = api.event?.on?.("session.idle", () => refreshPrompt());
  const disposePrompt = api.event?.on?.("session.prompt", () => refreshPrompt());

  solid.onCleanup(() => {
    if (disposeMessage) disposeMessage();
    if (disposeIdle) disposeIdle();
    if (disposePrompt) disposePrompt();
  });

  const node = solid.createElement("text");
  solid.spread(
    node,
    {
      get content() {
        const s = sessionState();
        const lastCount = s?.lastRecall?.matches?.length ?? 0;
        const totalCount = s?.history?.length ?? 0;
        return `${lastCount} 🧠 ${totalCount}`;
      },
      get fg() {
        const mcpList = api.state?.mcp?.() ?? [];
        const memoryMcp = mcpList.find((m: any) => m.name === "memory");
        if (memoryMcp && memoryMcp.status !== "connected") {
          return api.theme?.current?.error ?? "red";
        }
        const s = sessionState();
        const lastCount = s?.lastRecall?.matches?.length ?? 0;
        if (lastCount > 0) {
          return api.theme?.current?.warning ?? "yellow";
        }
        return api.theme?.current?.textMuted ?? "gray";
      },
      selectable: false,
      truncate: true,
      wrapMode: "none",
    },
    false,
  );

  return node;
}

function showMemoryDetailDialog(api: any, memoryItem: any) {
  api.ui?.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: `Memory: ${memoryItem.title || "Untitled"}`,
      message: [
        `ID: ${memoryItem.id}`,
        `Importance: ${memoryItem.importance_score ?? "N/A"}`,
        "",
        "Content / Snippet:",
        memoryItem.snippet || "(no content)",
      ].join("\n"),
      onConfirm: () => api.ui.dialog.clear(),
    }),
  );
}

function showMemoryStatsDialog(api: any) {
  fetchStatsAsync().then((s) => {
    const mcpList = api.state?.mcp?.() ?? [];
    const memoryMcp = mcpList.find((m: any) => m.name === "memory");

    api.ui?.dialog?.replace?.(() =>
      api.ui.DialogAlert({
        title: "MCP Memory Graph Status",
        message: [
          `Server Status: ${s.ok ? "Online" : "Offline"}`,
          `MCP Connection: ${memoryMcp ? memoryMcp.status : "connected"}`,
          `Active Memories: ${s.memories}`,
          `Web Dashboard: http://localhost:3100`,
        ].join("\n"),
        onConfirm: () => api.ui.dialog.clear(),
      }),
    );
  });
}

function createSidebarMemoryWidget(api: any, solid: any, sessionData: any) {
  const sessionId = () => sessionData?.session_id || "global";
  const sid = sessionId();

  // Retrieve persistent accordion state
  const accordion = getAccordionState(sid);
  const [mainExpanded, setMainExpanded] = solid.createSignal(accordion.main);
  const [lastRecallExpanded, setLastRecallExpanded] = solid.createSignal(accordion.lastRecall);
  const [historyExpanded, setHistoryExpanded] = solid.createSignal(accordion.history);

  const [sessionState, setSessionState] = solid.createSignal(readSessionState(sid));
  const [stats, setStats] = solid.createSignal(cachedStats);

  // Initial silent stats fetch
  fetchStatsAsync().then((s) => setStats(s)).catch(() => {});

  // 1. ROOT CONTAINER
  const rootBox = solid.createElement("box");
  solid.spread(rootBox, {
    flexDirection: "column",
    gap: 0,
    paddingLeft: 1,
    paddingRight: 1,
  });

  // 2. MAIN HEADER ROW (Full-width)
  const headerBox = solid.createElement("box");
  solid.spread(headerBox, {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 1,
  });

  // Title Box: single-click toggle
  const headerTitleBox = solid.createElement("box");
  solid.spread(headerTitleBox, {
    flexDirection: "row",
    gap: 1,
    onMouseDown: (e: any) => {
      e?.stopPropagation?.();
      e?.preventDefault?.();
      const next = !mainExpanded();
      setMainExpanded(next);
      accordion.main = next;
    },
  });

  const headerText = solid.createElement("text");
  solid.spread(headerText, {
    get content() {
      const exp = mainExpanded() ? "▼" : "▶";
      const count = stats().memories;
      return `${exp} 🧠 Memory Graph (${count})`;
    },
    get fg() {
      return api.theme?.current?.text ?? "white";
    },
    selectable: false,
  });
  safeAdd(headerTitleBox, headerText);
  safeAdd(headerBox, headerTitleBox);

  // Session ON/OFF Toggle Button
  const sessionToggleBtn = solid.createElement("text");
  solid.spread(sessionToggleBtn, {
    get content() {
      return sessionState().enabled ? " [● ON]" : " [○ OFF]";
    },
    get fg() {
      return sessionState().enabled
        ? api.theme?.current?.success ?? "green"
        : api.theme?.current?.textMuted ?? "gray";
    },
    selectable: false,
    onMouseDown: (e: any) => {
      e?.stopPropagation?.();
      e?.preventDefault?.();
      const next = toggleSessionMemory(sessionId());
      setSessionState(readSessionState(sessionId()));
      api.ui?.toast?.({
        title: "Session Memory",
        message: next ? "Memory recall enabled for this session" : "Memory recall disabled for this session",
        variant: next ? "info" : "warning",
      });
    },
  });
  safeAdd(headerBox, sessionToggleBtn);
  safeAdd(rootBox, headerBox);

  // 3. MAIN BODY CONTAINER (Powered by OpenTUI visible property — zero detach/attach!)
  const mainBodyBox = solid.createElement("box");
  solid.spread(mainBodyBox, {
    get visible() {
      return mainExpanded();
    },
    flexDirection: "column",
    gap: 0,
    paddingLeft: 1,
    paddingTop: 0,
  });
  safeAdd(rootBox, mainBodyBox);

  // ── SUB-SECTION 1: LAST RECALL ──────────────────────────────────────────
  const lastRecallContainer = solid.createElement("box");
  solid.spread(lastRecallContainer, { flexDirection: "column" });

  const lastRecallHeaderBox = solid.createElement("box");
  solid.spread(lastRecallHeaderBox, {
    flexDirection: "row",
    gap: 1,
    onMouseDown: (e: any) => {
      e?.stopPropagation?.();
      e?.preventDefault?.();
      const next = !lastRecallExpanded();
      setLastRecallExpanded(next);
      accordion.lastRecall = next;
    },
  });

  const lastRecallHeaderText = solid.createElement("text");
  solid.spread(lastRecallHeaderText, {
    get content() {
      const exp = lastRecallExpanded() ? "▼" : "▶";
      const count = sessionState().lastRecall?.matches?.length ?? 0;
      return `${exp} LAST RECALL (${count})`;
    },
    get fg() {
      return api.theme?.current?.textMuted ?? "gray";
    },
    selectable: false,
  });
  safeAdd(lastRecallHeaderBox, lastRecallHeaderText);
  safeAdd(lastRecallContainer, lastRecallHeaderBox);

  const lastRecallBodyBox = solid.createElement("box");
  solid.spread(lastRecallBodyBox, {
    get visible() {
      return lastRecallExpanded();
    },
    flexDirection: "column",
    paddingLeft: 1,
  });
  safeAdd(lastRecallContainer, lastRecallBodyBox);
  safeAdd(mainBodyBox, lastRecallContainer);

  // ── SUB-SECTION 2: SESSION RECALLS ──────────────────────────────────────
  const historyContainer = solid.createElement("box");
  solid.spread(historyContainer, { flexDirection: "column" });

  const historyHeaderBox = solid.createElement("box");
  solid.spread(historyHeaderBox, {
    flexDirection: "row",
    gap: 1,
    onMouseDown: (e: any) => {
      e?.stopPropagation?.();
      e?.preventDefault?.();
      const next = !historyExpanded();
      setHistoryExpanded(next);
      accordion.history = next;
    },
  });

  const historyHeaderText = solid.createElement("text");
  solid.spread(historyHeaderText, {
    get content() {
      const exp = historyExpanded() ? "▼" : "▶";
      const count = sessionState().history?.length ?? 0;
      return `${exp} SESSION RECALLS (${count})`;
    },
    get fg() {
      return api.theme?.current?.textMuted ?? "gray";
    },
    selectable: false,
  });
  safeAdd(historyHeaderBox, historyHeaderText);
  safeAdd(historyContainer, historyHeaderBox);

  const historyBodyBox = solid.createElement("box");
  solid.spread(historyBodyBox, {
    get visible() {
      return historyExpanded();
    },
    flexDirection: "column",
    paddingLeft: 1,
  });
  safeAdd(historyContainer, historyBodyBox);
  safeAdd(mainBodyBox, historyContainer);

  // Helper to render individual memory row with click targets on box elements
  const createMemoryRow = (item: MemoryItem) => {
    const isMuted = () => (sessionState().mutedIds || []).includes(item.id);
    const row = solid.createElement("box");
    solid.spread(row, { flexDirection: "row", gap: 1 });

    // Clickable Dot: Green (●) when active, Grayed out (○) when muted
    const dotBox = solid.createElement("box");
    solid.spread(dotBox, {
      flexShrink: 0,
      onMouseDown: (e: any) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        const nowMuted = toggleMemoryMute(sessionId(), item.id);
        const newState = readSessionState(sessionId());
        setSessionState(newState);
        lastRecallHash = "";
        historyHash = "";
        updateContentBoxes(newState);
        api.ui?.toast?.({
          title: nowMuted ? "Memory Muted" : "Memory Restored",
          message: nowMuted ? "Muted for this session" : "Active in this session",
          variant: nowMuted ? "warning" : "info",
        });
      },
    });

    const statusDot = solid.createElement("text");
    solid.spread(statusDot, {
      get content() {
        return isMuted() ? "○" : "●";
      },
      get fg() {
        return isMuted() ? api.theme?.current?.textMuted ?? "gray" : api.theme?.current?.success ?? "green";
      },
      selectable: false,
    });
    safeAdd(dotBox, statusDot);

    // Title text: clicking opens the full memory detail dialog
    const titleBox = solid.createElement("box");
    solid.spread(titleBox, {
      flexGrow: 1,
      onMouseDown: (e: any) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        showMemoryDetailDialog(api, item);
      },
    });

    const titleText = solid.createElement("text");
    const displayTitle = item.title.length > 25 ? item.title.slice(0, 23) + "…" : item.title;
    solid.spread(titleText, {
      content: displayTitle,
      get fg() {
        return isMuted() ? api.theme?.current?.textMuted ?? "gray" : api.theme?.current?.text ?? "white";
      },
      truncate: true,
      selectable: false,
    });
    safeAdd(titleBox, titleText);

    safeAdd(row, dotBox);
    safeAdd(row, titleBox);
    return row;
  };

  // Content change detection hashes to prevent unnecessary DOM mutations
  let lastRecallHash = "";
  let historyHash = "";

  const updateContentBoxes = (state: SessionState) => {
    // 1. Last Recall
    const currentLrHash = JSON.stringify(state.lastRecall ?? null);
    if (currentLrHash !== lastRecallHash) {
      lastRecallHash = currentLrHash;
      safeClear(lastRecallBodyBox);
      const lr = state.lastRecall;
      if (!lr || !lr.matches || lr.matches.length === 0) {
        const noneText = solid.createElement("text");
        solid.spread(noneText, {
          content: "  (none in last turn)",
          get fg() {
            return api.theme?.current?.textMuted ?? "gray";
          },
          selectable: false,
        });
        safeAdd(lastRecallBodyBox, noneText);
      } else {
        for (const match of lr.matches) {
          safeAdd(lastRecallBodyBox, createMemoryRow(match));
        }
        if (lr.tokens && lr.tokens.length > 0) {
          const tokensText = solid.createElement("text");
          solid.spread(tokensText, {
            content: `   tokens: ${lr.tokens.slice(0, 4).join(", ")}`,
            get fg() {
              return api.theme?.current?.textMuted ?? "gray";
            },
            truncate: true,
            selectable: false,
          });
          safeAdd(lastRecallBodyBox, tokensText);
        }
      }
    }

    // 2. History
    const currentHistHash = JSON.stringify(state.history ?? []);
    if (currentHistHash !== historyHash) {
      historyHash = currentHistHash;
      safeClear(historyBodyBox);
      const hist = state.history || [];
      const maxItems = Math.min(hist.length, 5);

      if (hist.length === 0) {
        const emptyText = solid.createElement("text");
        solid.spread(emptyText, {
          content: "  (no recalls yet)",
          get fg() {
            return api.theme?.current?.textMuted ?? "gray";
          },
          selectable: false,
        });
        safeAdd(historyBodyBox, emptyText);
      } else {
        for (let i = 0; i < maxItems; i++) {
          safeAdd(historyBodyBox, createMemoryRow(hist[i]));
        }
      }
    }
  };

  // Event-driven refreshes
  const refresh = () => {
    const currentSid = sessionId();
    const newState = readSessionState(currentSid);
    setSessionState(newState);
    updateContentBoxes(newState);
  };

  // Initial populate
  const initialState = readSessionState(sid);
  updateContentBoxes(initialState);

  // 100% Event-driven refreshes on message completion, prompt send, and session idle (zero polling)
  const disposeMessage = api.event?.on?.("message.updated", (e: any) => {
    if (e.properties?.info?.time?.completed) {
      refresh();
      fetchStatsAsync().then((s) => setStats(s)).catch(() => {});
    }
  });
  const disposePrompt = api.event?.on?.("session.prompt", () => {
    refresh();
  });
  const disposeIdle = api.event?.on?.("session.idle", () => {
    refresh();
    fetchStatsAsync().then((s) => setStats(s)).catch(() => {});
  });

  solid.onCleanup(() => {
    if (disposeMessage) disposeMessage();
    if (disposePrompt) disposePrompt();
    if (disposeIdle) disposeIdle();
  });

  return rootBox;
}

const moduleExport = {
  id: PLUGIN_ID,
  async tui(api: any) {
    let solid: any = null;
    try {
      // @ts-ignore
      const opentuiMod = await import("@opentui/solid");
      // @ts-ignore
      const solidMod = await import("solid-js");
      solid = {
        createElement: opentuiMod.createElement,
        spread: opentuiMod.spread,
        createSignal: solidMod.createSignal,
        onCleanup: solidMod.onCleanup,
      };
    } catch {
      return;
    }

    // 1. Register prompt bar status (right slot)
    api.slots?.register?.({
      slots: {
        session_prompt_right: (arg1: any, arg2: any) => {
          const data = arg2 !== undefined ? arg2 : arg1;
          return createMemoryPromptStatus(api, solid, data);
        },
        home_prompt_right: (arg1: any, arg2: any) => {
          const data = arg2 !== undefined ? arg2 : arg1;
          return createMemoryPromptStatus(api, solid, data);
        },
      },
    });

    // 2. Register Sidebar Widget (order: 250 sits right between MCP and LSP)
    api.slots?.register?.({
      order: 250,
      slots: {
        sidebar_content: (context: any, data: any) =>
          createSidebarMemoryWidget(api, solid, data),
      },
    });

    // 3. Register command palette actions
    const disposeCommand = api.command?.register?.(() => [
      {
        title: "Memory Graph: View status & statistics",
        value: "memory.stats.dialog",
        description: "Display active memory counts and entity graph status",
        category: "Memory",
        onSelect: () => showMemoryStatsDialog(api),
      },
    ]);
    if (disposeCommand && api.lifecycle?.onDispose) {
      api.lifecycle.onDispose(disposeCommand);
    }
  },
};

export default moduleExport;
