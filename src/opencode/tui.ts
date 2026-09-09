import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const PLUGIN_ID = "mcp-memory-graph.status";

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

function getMemoryDbPath(): string {
  return process.env.MCP_MEMORY_DB_PATH || join(homedir(), ".mcp-memory", "memory.db");
}

let bunDatabaseClass: any = null;

async function initSqliteEngine(): Promise<void> {
  // @ts-ignore
  if (typeof Bun !== "undefined") {
    try {
      // @ts-ignore
      const mod = await import("bun:sqlite");
      bunDatabaseClass = mod.Database;
    } catch {
      // safe ignore
    }
  }
}

/**
 * Directly queries SQLite for live memory count.
 * Uses native bun:sqlite in OpenCode runtime, or better-sqlite3 in Node.js / Vitest.
 */
function getMemoryCountFromSqlite(): number {
  const dbPath = getMemoryDbPath();
  if (!existsSync(dbPath)) return 0;

  // 1. Bun native SQLite (OpenCode environment)
  if (bunDatabaseClass) {
    try {
      const db = new bunDatabaseClass(dbPath, { readonly: true });
      const row = db
        .query(
          "SELECT count(*) as count FROM memories WHERE parent_id IS NULL AND superseded_at IS NULL AND tx_expired IS NULL",
        )
        .get() as { count: number };
      db.close();
      return row?.count ?? 0;
    } catch {
      // fallback to better-sqlite3
    }
  }

  // 2. Node.js environment (Vitest / CLI)
  try {
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT count(*) as count FROM memories WHERE parent_id IS NULL AND superseded_at IS NULL AND tx_expired IS NULL",
      )
      .get() as { count: number };
    db.close();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
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

/**
 * Safe DOM manipulations that check presence and pass string IDs to OpenTUI's remove(id).
 */
function safeAdd(parent: any, child: any): void {
  if (!parent || !child) return;
  const children = typeof parent.getChildren === "function" ? parent.getChildren() : [];
  if (children.includes(child)) return; // prevent duplicate node attachment in Yoga
  if (typeof parent.add === "function") {
    parent.add(child);
  } else if (typeof parent.appendChild === "function") {
    parent.appendChild(child);
  }
}

function safeRemove(parent: any, child: any): void {
  if (!parent || !child) return;
  const children = typeof parent.getChildren === "function" ? parent.getChildren() : [];
  if (!children.includes(child)) return; // not attached
  const id = typeof child === "string" ? child : child?.id;
  if (id && typeof parent.remove === "function") {
    parent.remove(id);
  } else if (typeof parent.remove === "function") {
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

// Persistent accordion state per session
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

/**
 * Prompt bar mini status widget (e.g. "3 🧠 18")
 */
function createMemoryPromptStatus(api: any, solid: any, sessionData?: any) {
  const sessionId = () => sessionData?.session_id || "global";
  const [sessionState, setSessionState] = solid.createSignal(readSessionState(sessionId()));
  const [totalMemories, setTotalMemories] = solid.createSignal(getMemoryCountFromSqlite());

  const refreshPrompt = () => {
    setSessionState(readSessionState(sessionId()));
    setTotalMemories(getMemoryCountFromSqlite());
  };

  refreshPrompt();

  const disposeMessage = api.event?.on?.("message.updated", (e: any) => {
    if (e.properties?.info?.time?.completed) {
      refreshPrompt();
    }
  });
  const disposeIdle = api.event?.on?.("session.idle", () => refreshPrompt());
  const disposePrompt = api.event?.on?.("session.prompt", () => refreshPrompt());

  solid.onCleanup?.(() => {
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
        const sessionRecallCount = s?.history?.length ?? 0;
        const dbTotalCount = totalMemories();
        return `${sessionRecallCount} 🧠 ${dbTotalCount}`;
      },
      get fg() {
        const mcpList = api.state?.mcp?.() ?? [];
        const memoryMcp = mcpList.find((m: any) => m.name === "memory");
        if (memoryMcp && memoryMcp.status !== "connected") {
          return api.theme?.current?.error ?? "red";
        }
        const s = sessionState();
        const hasRecall = (s?.lastRecall?.matches?.length ?? 0) > 0;
        if (hasRecall) {
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
  const count = getMemoryCountFromSqlite();
  const mcpList = api.state?.mcp?.() ?? [];
  const memoryMcp = mcpList.find((m: any) => m.name === "memory");

  api.ui?.dialog?.replace?.(() =>
    api.ui.DialogAlert({
      title: "MCP Memory Graph Status",
      message: [
        `Database: ${getMemoryDbPath()}`,
        `MCP Connection: ${memoryMcp ? memoryMcp.status : "connected"}`,
        `Active Memories: ${count}`,
        `Storage Engine: SQLite (Local-First)`,
      ].join("\n"),
      onConfirm: () => api.ui.dialog.clear(),
    }),
  );
}

/**
 * Sidebar Memory Graph Widget (Ultra-Stable Tree Structure)
 */
function createSidebarMemoryWidget(api: any, solid: any, sessionData: any) {
  const sid = sessionData?.session_id || "global";
  const accordion = getAccordionState(sid);

  let mainExpanded = accordion.main;
  let lastRecallExpanded = accordion.lastRecall;
  let historyExpanded = accordion.history;

  let currentSessionState = readSessionState(sid);
  let memoryCount = getMemoryCountFromSqlite();

  // 1. ROOT CONTAINER (flexShrink: 0 & width: 100% prevent layout shrinkage)
  const rootBox = solid.createElement("box");
  solid.spread(rootBox, {
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    gap: 0,
    paddingLeft: 1,
    paddingRight: 1,
  });

  // 2. MAIN HEADER ROW
  const headerBox = solid.createElement("box");
  solid.spread(headerBox, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    gap: 1,
  });

  // Main Title Box (Toggle main accordion)
  const headerTitleBox = solid.createElement("box");
  const headerText = solid.createElement("text");

  const updateHeaderText = () => {
    const exp = mainExpanded ? "▼" : "▶";
    solid.spread(headerText, {
      content: `${exp} 🧠 Memory Graph (${memoryCount})`,
      fg: api.theme?.current?.text ?? "white",
      selectable: false,
    });
  };
  updateHeaderText();
  safeAdd(headerTitleBox, headerText);

  solid.spread(headerTitleBox, {
    flexDirection: "row",
    gap: 1,
    onMouseUp: () => {
      mainExpanded = !mainExpanded;
      accordion.main = mainExpanded;
      syncMainVisibility();
    },
  });
  safeAdd(headerBox, headerTitleBox);

  // Session ON/OFF Toggle Button
  const sessionToggleBox = solid.createElement("box");
  const sessionToggleText = solid.createElement("text");

  const updateToggleText = (enabled: boolean) => {
    solid.spread(sessionToggleText, {
      content: enabled ? " [● ON]" : " [○ OFF]",
      fg: enabled ? api.theme?.current?.success ?? "green" : api.theme?.current?.textMuted ?? "gray",
      selectable: false,
    });
  };
  updateToggleText(currentSessionState.enabled);
  safeAdd(sessionToggleBox, sessionToggleText);

  solid.spread(sessionToggleBox, {
    flexShrink: 0,
    onMouseUp: () => {
      const next = toggleSessionMemory(sid);
      currentSessionState = readSessionState(sid);
      updateToggleText(next);
      api.ui?.toast?.({
        title: "Session Memory",
        message: next ? "Memory recall enabled for this session" : "Memory recall disabled for this session",
        variant: next ? "info" : "warning",
      });
    },
  });
  safeAdd(headerBox, sessionToggleBox);
  safeAdd(rootBox, headerBox);

  // 3. MAIN BODY CONTAINER (Permanently attached; visibility controlled by mainBodyBox.visible)
  const mainBodyBox = solid.createElement("box");
  solid.spread(mainBodyBox, {
    flexDirection: "column",
    width: "100%",
    gap: 0,
    paddingLeft: 1,
  });
  safeAdd(rootBox, mainBodyBox);

  // ── Section 1: LAST RECALL ────────────────────────────────────────────────
  const lastRecallContainer = solid.createElement("box");
  solid.spread(lastRecallContainer, { flexDirection: "column", width: "100%" });

  const lastRecallHeaderBox = solid.createElement("box");
  const lastRecallHeaderText = solid.createElement("text");
  safeAdd(lastRecallHeaderBox, lastRecallHeaderText);
  safeAdd(lastRecallContainer, lastRecallHeaderBox);

  const lastRecallBodyBox = solid.createElement("box");
  solid.spread(lastRecallBodyBox, {
    flexDirection: "column",
    width: "100%",
    paddingLeft: 1,
  });
  safeAdd(lastRecallContainer, lastRecallBodyBox);

  const updateLastRecallHeader = () => {
    const lastMatches = currentSessionState.lastRecall?.matches ?? [];
    const lrExp = lastRecallExpanded ? "▼" : "▶";
    solid.spread(lastRecallHeaderText, {
      content: `${lrExp} LAST RECALL (${lastMatches.length})`,
      fg: api.theme?.current?.textMuted ?? "gray",
      selectable: false,
    });
  };

  const syncLastRecallVisibility = () => {
    updateLastRecallHeader();
    lastRecallBodyBox.visible = lastRecallExpanded;
  };

  solid.spread(lastRecallHeaderBox, {
    flexDirection: "row",
    width: "100%",
    gap: 1,
    onMouseUp: () => {
      lastRecallExpanded = !lastRecallExpanded;
      accordion.lastRecall = lastRecallExpanded;
      syncLastRecallVisibility();
    },
  });
  safeAdd(mainBodyBox, lastRecallContainer);

  // ── Section 2: SESSION RECALLS ────────────────────────────────────────────
  const historyContainer = solid.createElement("box");
  solid.spread(historyContainer, { flexDirection: "column", width: "100%" });

  const historyHeaderBox = solid.createElement("box");
  const historyHeaderText = solid.createElement("text");
  safeAdd(historyHeaderBox, historyHeaderText);
  safeAdd(historyContainer, historyHeaderBox);

  const historyBodyBox = solid.createElement("box");
  solid.spread(historyBodyBox, {
    flexDirection: "column",
    width: "100%",
    paddingLeft: 1,
  });
  safeAdd(historyContainer, historyBodyBox);

  const updateHistoryHeader = () => {
    const hist = currentSessionState.history || [];
    const histExp = historyExpanded ? "▼" : "▶";
    solid.spread(historyHeaderText, {
      content: `${histExp} SESSION RECALLS (${hist.length})`,
      fg: api.theme?.current?.textMuted ?? "gray",
      selectable: false,
    });
  };

  const syncHistoryVisibility = () => {
    updateHistoryHeader();
    historyBodyBox.visible = historyExpanded;
  };

  solid.spread(historyHeaderBox, {
    flexDirection: "row",
    width: "100%",
    gap: 1,
    onMouseUp: () => {
      historyExpanded = !historyExpanded;
      accordion.history = historyExpanded;
      syncHistoryVisibility();
    },
  });
  safeAdd(mainBodyBox, historyContainer);

  const syncMainVisibility = () => {
    updateHeaderText();
    mainBodyBox.visible = mainExpanded;
  };

  // Helper to render an interactive memory row with local in-place mute updates
  const createMemoryRow = (item: MemoryItem) => {
    let isMuted = (currentSessionState.mutedIds || []).includes(item.id);
    const row = solid.createElement("box");
    solid.spread(row, { flexDirection: "row", width: "100%", gap: 1 });

    // Clickable Dot: Green (●) when active, Gray (○) when muted
    const dotBox = solid.createElement("box");
    const statusDot = solid.createElement("text");
    solid.spread(statusDot, {
      content: isMuted ? "○" : "●",
      fg: isMuted ? api.theme?.current?.textMuted ?? "gray" : api.theme?.current?.success ?? "green",
      selectable: false,
    });
    safeAdd(dotBox, statusDot);
    safeAdd(row, dotBox);

    // Clickable Title: opens details modal
    const titleBox = solid.createElement("box");
    const displayTitle = item.title.length > 25 ? item.title.slice(0, 23) + "…" : item.title;
    const titleText = solid.createElement("text");
    solid.spread(titleText, {
      content: displayTitle,
      fg: isMuted ? api.theme?.current?.textMuted ?? "gray" : api.theme?.current?.text ?? "white",
      truncate: true,
      selectable: false,
    });
    safeAdd(titleBox, titleText);
    safeAdd(row, titleBox);

    solid.spread(titleBox, {
      flexGrow: 1,
      onMouseUp: () => showMemoryDetailDialog(api, item),
    });

    solid.spread(dotBox, {
      flexShrink: 0,
      onMouseUp: () => {
        const nowMuted = toggleMemoryMute(sid, item.id);
        currentSessionState = readSessionState(sid);
        isMuted = nowMuted;
        // In-place visual update (zero DOM rebuilding, completely rock-solid)
        solid.spread(statusDot, {
          content: isMuted ? "○" : "●",
          fg: isMuted ? api.theme?.current?.textMuted ?? "gray" : api.theme?.current?.success ?? "green",
        });
        solid.spread(titleText, {
          fg: isMuted ? api.theme?.current?.textMuted ?? "gray" : api.theme?.current?.text ?? "white",
        });
        api.ui?.toast?.({
          title: nowMuted ? "Memory Muted" : "Memory Restored",
          message: nowMuted ? "Muted for this session" : "Active in this session",
          variant: nowMuted ? "warning" : "info",
        });
      },
    });

    return row;
  };

  // Re-populates the contents of lastRecallBodyBox and historyBodyBox
  const populateData = () => {
    memoryCount = getMemoryCountFromSqlite();
    updateHeaderText();
    updateToggleText(currentSessionState.enabled);
    updateLastRecallHeader();
    updateHistoryHeader();

    // 1. Populate Last Recall items
    safeClear(lastRecallBodyBox);
    const lastMatches = currentSessionState.lastRecall?.matches ?? [];
    if (lastMatches.length === 0) {
      const noneText = solid.createElement("text");
      solid.spread(noneText, {
        content: "  (none in last turn)",
        fg: api.theme?.current?.textMuted ?? "gray",
        selectable: false,
      });
      safeAdd(lastRecallBodyBox, noneText);
    } else {
      for (const match of lastMatches) {
        safeAdd(lastRecallBodyBox, createMemoryRow(match));
      }
      const tokens = currentSessionState.lastRecall?.tokens ?? [];
      if (tokens.length > 0) {
        const tokensText = solid.createElement("text");
        solid.spread(tokensText, {
          content: `   tokens: ${tokens.slice(0, 4).join(", ")}`,
          fg: api.theme?.current?.textMuted ?? "gray",
          truncate: true,
          selectable: false,
        });
        safeAdd(lastRecallBodyBox, tokensText);
      }
    }

    // 2. Populate History items
    safeClear(historyBodyBox);
    const hist = currentSessionState.history || [];
    const maxItems = Math.min(hist.length, 5);
    if (hist.length === 0) {
      const emptyText = solid.createElement("text");
      solid.spread(emptyText, {
        content: "  (no recalls yet)",
        fg: api.theme?.current?.textMuted ?? "gray",
        selectable: false,
      });
      safeAdd(historyBodyBox, emptyText);
    } else {
      for (let i = 0; i < maxItems; i++) {
        safeAdd(historyBodyBox, createMemoryRow(hist[i]));
      }
    }
  };

  // Initial setup of the tree
  populateData();
  syncLastRecallVisibility();
  syncHistoryVisibility();
  syncMainVisibility();

  // Lifecycle Event Listeners (Event-driven refresh when new memories are recalled)
  const refreshFromDisk = () => {
    currentSessionState = readSessionState(sid);
    populateData();
  };

  const disposeMessage = api.event?.on?.("message.updated", (e: any) => {
    if (e.properties?.info?.time?.completed) {
      refreshFromDisk();
    }
  });

  const disposePrompt = api.event?.on?.("session.prompt", () => refreshFromDisk());
  const disposeIdle = api.event?.on?.("session.idle", () => refreshFromDisk());

  solid.onCleanup?.(() => {
    if (disposeMessage) disposeMessage();
    if (disposePrompt) disposePrompt();
    if (disposeIdle) disposeIdle();
  });

  return rootBox;
}

const moduleExport = {
  id: PLUGIN_ID,
  async tui(api: any) {
    await initSqliteEngine();

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
        sidebar_content: (_context: any, data: any) =>
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

export {
  PLUGIN_ID,
  getMemoryDbPath,
  getMemoryCountFromSqlite,
  getSessionStatePath,
  readSessionState,
  saveSessionState,
  toggleSessionMemory,
  toggleMemoryMute,
  safeAdd,
  safeRemove,
  safeClear,
  getAccordionState,
  createMemoryPromptStatus,
  showMemoryDetailDialog,
  showMemoryStatsDialog,
  createSidebarMemoryWidget,
};

export default moduleExport;
