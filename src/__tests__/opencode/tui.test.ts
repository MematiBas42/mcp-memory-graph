import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// ── OpenTUI Renderable Test Harness ──────────────────────────────────────────
let nodeCounter = 0;

interface MockNode {
  id: string;
  type: string;
  props: Record<string, any>;
  parent: MockNode | null;
  visible: boolean;
  getChildren: () => MockNode[];
  add: (child: MockNode) => void;
  remove: (id: string) => void;
}

const createMockNode = (type: string): MockNode => {
  const children: MockNode[] = [];
  const node: MockNode = {
    id: `${type}-${++nodeCounter}`,
    type,
    props: {},
    parent: null,
    visible: true,
    getChildren: () => [...children],
    add: (child: MockNode) => {
      if (!child || typeof child !== "object") {
        throw new Error("Invalid child passed to add()");
      }
      if (children.some((c) => c === child || c.id === child.id)) {
        throw new Error(`Duplicate child: node '${child.id}' is already attached to '${node.id}'`);
      }
      child.parent = node;
      children.push(child);
    },
    remove: (id: string) => {
      // OpenTUI Renderable contract: MUST receive a string id.
      // If passed an object or undefined, it strictly does NOT remove anything!
      if (typeof id !== "string") {
        return;
      }
      const idx = children.findIndex((c) => c.id === id);
      if (idx !== -1) {
        const [removed] = children.splice(idx, 1);
        removed.parent = null;
      }
    },
  };
  return node;
};

let cleanups: (() => void)[] = [];

vi.mock("@opentui/solid", () => ({
  createElement: (type: string) => createMockNode(type),
  spread: (node: any, props: any) => {
    const descriptors = Object.getOwnPropertyDescriptors(props);
    for (const [key, desc] of Object.entries(descriptors)) {
      if (desc.get || desc.set) {
        Object.defineProperty(node.props, key, desc);
      } else {
        node.props[key] = desc.value;
      }
    }
  },
}));

vi.mock("solid-js", () => ({
  createSignal: (val: any) => {
    let curr = val;
    return [
      () => curr,
      (next: any) => {
        curr = typeof next === "function" ? next(curr) : next;
        return curr;
      },
    ];
  },
  onCleanup: (fn: () => void) => {
    cleanups.push(fn);
  },
}));

let currentTempDir = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => (currentTempDir ? currentTempDir : actual.homedir()),
  };
});

import tuiPlugin, {
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
  createMemoryPromptStatus,
  createSidebarMemoryWidget,
  showMemoryDetailDialog,
  showMemoryStatsDialog,
} from "../../opencode/tui.js";

// Helper to create mock OpenCode API
function createMockApi(overrides: Record<string, any> = {}) {
  const eventListeners: Record<string, ((...args: any[]) => void)[]> = {};
  const slotsRegistered: any[] = [];
  const commandsRegistered: any[] = [];

  const mockApi = {
    slots: {
      register: vi.fn((def) => {
        slotsRegistered.push(def);
      }),
    },
    command: {
      register: vi.fn((factory) => {
        const cmds = factory();
        commandsRegistered.push(cmds);
        return () => {};
      }),
    },
    lifecycle: {
      onDispose: vi.fn(),
    },
    state: {
      mcp: () => [{ name: "memory", status: "connected" }],
    },
    theme: {
      current: {
        text: "#ffffff",
        textMuted: "#888888",
        success: "#00ff00",
        warning: "#ffff00",
        error: "#ff0000",
      },
    },
    ui: {
      toast: vi.fn(),
      dialog: {
        replace: vi.fn((factory) => factory()),
        clear: vi.fn(),
      },
      DialogAlert: vi.fn((opts) => opts),
    },
    event: {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!eventListeners[event]) eventListeners[event] = [];
        eventListeners[event].push(handler);
        return () => {
          const idx = eventListeners[event].indexOf(handler);
          if (idx !== -1) eventListeners[event].splice(idx, 1);
        };
      }),
      emit: (event: string, ...args: any[]) => {
        const handlers = [...(eventListeners[event] || [])];
        for (const h of handlers) h(...args);
      },
    },
    _slotsRegistered: slotsRegistered,
    _commandsRegistered: commandsRegistered,
    _eventListeners: eventListeners,
    ...overrides,
  };

  return mockApi;
}

describe("OpenCode TUI Rigorous Test Suite", () => {
  let tempDbPath: string;

  beforeEach(() => {
    nodeCounter = 0;
    cleanups = [];
    currentTempDir = mkdtempSync(join(tmpdir(), "mcp-tui-test-"));
    tempDbPath = join(currentTempDir, "test-memory.db");
    process.env.MCP_MEMORY_DB_PATH = tempDbPath;
  });

  afterEach(() => {
    delete process.env.MCP_MEMORY_DB_PATH;
    if (currentTempDir && existsSync(currentTempDir)) {
      rmSync(currentTempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. OpenTUI Renderable Sözleşmesi & DOM Utility Güvenliği
  // ───────────────────────────────────────────────────────────────────────────
  describe("OpenTUI Renderable Contract & DOM Utilities", () => {
    it("enforces string id on remove() and rejects object-based removal", () => {
      const parent = createMockNode("box");
      const child = createMockNode("text");
      parent.add(child);

      expect(parent.getChildren()).toHaveLength(1);
      expect(child.parent).toBe(parent);

      // Passing an object directly to OpenTUI remove(id: string) MUST FAIL silently (contract check)
      parent.remove(child as any);
      expect(parent.getChildren()).toHaveLength(1); // STILL THERE!
      expect(child.parent).toBe(parent);

      // Passing a non-existent string id does not remove anything
      parent.remove("non-existent-id");
      expect(parent.getChildren()).toHaveLength(1);

      // Passing the valid string id removes the child cleanly
      parent.remove(child.id);
      expect(parent.getChildren()).toHaveLength(0);
      expect(child.parent).toBeNull();
    });

    it("throws when adding a duplicate node via native add(), but safeAdd() guards against it", () => {
      const parent = createMockNode("box");
      const child = createMockNode("text");

      safeAdd(parent, child);
      expect(parent.getChildren()).toHaveLength(1);

      // Calling safeAdd again should safely NO-OP without crashing Yoga
      safeAdd(parent, child);
      expect(parent.getChildren()).toHaveLength(1);

      // But direct native parent.add(child) on an already attached node throws
      expect(() => parent.add(child)).toThrow(/Duplicate child/);
    });

    it("safeRemove() extracts child.id and calls parent.remove(id: string)", () => {
      const parent = createMockNode("box");
      const child = createMockNode("text");
      safeAdd(parent, child);
      expect(parent.getChildren()).toHaveLength(1);

      // safeRemove with child object extracts child.id and calls parent.remove(string)
      safeRemove(parent, child);
      expect(parent.getChildren()).toHaveLength(0);

      // safeRemove when child is not attached is a no-op
      safeRemove(parent, child);
      expect(parent.getChildren()).toHaveLength(0);
    });

    it("safeClear() removes all children sequentially without leaving orphaned nodes", () => {
      const parent = createMockNode("box");
      const child1 = createMockNode("text");
      const child2 = createMockNode("box");
      const child3 = createMockNode("text");

      safeAdd(parent, child1);
      safeAdd(parent, child2);
      safeAdd(parent, child3);
      expect(parent.getChildren()).toHaveLength(3);

      safeClear(parent);
      expect(parent.getChildren()).toHaveLength(0);
      expect(child1.parent).toBeNull();
      expect(child2.parent).toBeNull();
      expect(child3.parent).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Gerçek SQLite Entegrasyonu
  // ───────────────────────────────────────────────────────────────────────────
  describe("Real SQLite Database Integration", () => {
    it("returns 0 when database does not exist", () => {
      process.env.MCP_MEMORY_DB_PATH = join(currentTempDir, "does-not-exist.db");
      expect(getMemoryCountFromSqlite()).toBe(0);
    });

    it("returns accurate count from a real SQLite database matching all query conditions", () => {
      // Create real SQLite database
      const db = new Database(tempDbPath);
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          superseded_at TEXT,
          tx_expired TEXT,
          title TEXT,
          content TEXT
        );
      `);

      // 0 initial count
      expect(getMemoryCountFromSqlite()).toBe(0);

      const insert = db.prepare(`
        INSERT INTO memories (id, parent_id, superseded_at, tx_expired, title, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      // Insert 3 active top-level memories
      insert.run("mem-1", null, null, null, "Active 1", "Content 1");
      insert.run("mem-2", null, null, null, "Active 2", "Content 2");
      insert.run("mem-3", null, null, null, "Active 3", "Content 3");

      // Insert records that MUST be excluded:
      // 1. Child chunk (has parent_id)
      insert.run("mem-chunk", "mem-1", null, null, "Chunk", "Chunk content");
      // 2. Superseded memory
      insert.run("mem-old", null, "2026-09-01T00:00:00Z", null, "Superseded", "Old content");
      // 3. Expired memory
      insert.run("mem-exp", null, null, "2026-09-02T00:00:00Z", "Expired", "Expired content");

      db.close();

      // Exactly 3 active memories should be counted
      const count = getMemoryCountFromSqlite();
      expect(count).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Gerçek Oturum (Session JSON) Entegrasyonu
  // ───────────────────────────────────────────────────────────────────────────
  describe("Real Session JSON Disk Integration", () => {
    const testSessionId = "session-rigorous-123";

    it("returns default state when session file does not exist on disk", () => {
      const state = readSessionState(testSessionId);
      expect(state).toEqual({
        enabled: true,
        mutedIds: [],
        history: [],
      });
    });

    it("saves and reads session state to/from disk with full fidelity", () => {
      const statePath = getSessionStatePath(testSessionId);
      expect(statePath).toContain(currentTempDir);

      const sampleState = {
        enabled: false,
        mutedIds: ["mem-a", "mem-b"],
        lastRecall: {
          ts: "2026-09-09T12:00:00Z",
          tokens: ["auth", "token"],
          matches: [
            { id: "mem-a", title: "Auth Flow", snippet: "Token validation", importance_score: 0.9 },
          ],
        },
        history: [
          { id: "mem-a", title: "Auth Flow", snippet: "Token validation", importance_score: 0.9 },
        ],
      };

      saveSessionState(testSessionId, sampleState);
      expect(existsSync(statePath)).toBe(true);

      // Verify raw file contents on disk
      const raw = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(raw.enabled).toBe(false);
      expect(raw.mutedIds).toEqual(["mem-a", "mem-b"]);
      expect(raw.lastRecall.tokens).toEqual(["auth", "token"]);

      // Verify readSessionState reads back correctly
      const loaded = readSessionState(testSessionId);
      expect(loaded).toEqual(sampleState);
    });

    it("toggleSessionMemory() flips enabled boolean on disk", () => {
      const statePath = getSessionStatePath(testSessionId);

      // Starts default true -> toggle turns false
      const first = toggleSessionMemory(testSessionId);
      expect(first).toBe(false);
      let onDisk = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(onDisk.enabled).toBe(false);

      // Toggle again -> turns true
      const second = toggleSessionMemory(testSessionId);
      expect(second).toBe(true);
      onDisk = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(onDisk.enabled).toBe(true);
    });

    it("toggleMemoryMute() adds and removes memory ID from disk", () => {
      const statePath = getSessionStatePath(testSessionId);

      // 1. Mute mem-1
      const isMuted1 = toggleMemoryMute(testSessionId, "mem-1");
      expect(isMuted1).toBe(true);
      let onDisk = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(onDisk.mutedIds).toContain("mem-1");

      // 2. Mute mem-2
      const isMuted2 = toggleMemoryMute(testSessionId, "mem-2");
      expect(isMuted2).toBe(true);
      onDisk = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(onDisk.mutedIds).toEqual(["mem-1", "mem-2"]);

      // 3. Unmute mem-1
      const isUnmuted1 = toggleMemoryMute(testSessionId, "mem-1");
      expect(isUnmuted1).toBe(false);
      onDisk = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(onDisk.mutedIds).toEqual(["mem-2"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Tüm UI Etkileşimlerinin Uçtan Uca Test Edilmesi
  // ───────────────────────────────────────────────────────────────────────────
  describe("End-to-End UI Interactions & Tree Stability", () => {
    const sid = "session-ui-e2e";

    beforeEach(() => {
      // Seed real database with 5 memories
      const db = new Database(tempDbPath);
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          superseded_at TEXT,
          tx_expired TEXT,
          title TEXT,
          content TEXT
        );
        INSERT INTO memories VALUES
          ('m-1', null, null, null, 'Root Access Policy', 'Rules about pkexec'),
          ('m-2', null, null, null, 'Background Process Pattern', 'Disown pattern'),
          ('m-3', null, null, null, 'SSH LAN Tunneling', 'Direct connection rule'),
          ('m-4', null, null, null, 'API Proxy Setup', 'CLIProxy config'),
          ('m-5', null, null, null, 'Docker Cache Optimization', 'Buildkit mount');
      `);
      db.close();

      // Seed session on disk
      saveSessionState(sid, {
        enabled: true,
        mutedIds: [],
        lastRecall: {
          ts: "2026-09-09T10:00:00Z",
          tokens: ["pkexec", "root"],
          matches: [
            {
              id: "m-1",
              title: "Root Access Policy with pkexec",
              snippet: "Use pkexec for non-interactive commands",
              importance_score: 0.95,
            },
            {
              id: "m-2",
              title: "Background Process Pattern",
              snippet: "Disown pattern for persistent jobs",
              importance_score: 0.8,
            },
          ],
        },
        history: [
          {
            id: "m-1",
            title: "Root Access Policy with pkexec",
            snippet: "Use pkexec for non-interactive commands",
            importance_score: 0.95,
          },
          {
            id: "m-2",
            title: "Background Process Pattern",
            snippet: "Disown pattern for persistent jobs",
            importance_score: 0.8,
          },
          {
            id: "m-3",
            title: "SSH LAN Tunneling",
            snippet: "Direct connection rule",
            importance_score: 0.7,
          },
        ],
      });
    });

    it("Main Accordion Toggle: folds and unfolds 10 times with zero ghost nodes or layout corruption", () => {
      const mockApi = createMockApi();
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => {
          Object.assign(node.props, props);
        },
        createSignal: (v: any) => [() => v, () => {}],
        onCleanup: (fn: any) => cleanups.push(fn),
      };

      const rootBox = createSidebarMemoryWidget(mockApi, solid, { session_id: sid });
      expect(rootBox.getChildren()).toHaveLength(2);

      const [headerBox, mainBodyBox] = rootBox.getChildren();
      const [headerTitleBox] = headerBox.getChildren();
      const [headerText] = headerTitleBox.getChildren();

      expect(headerText.props.content).toContain("▼ 🧠 Memory Graph (5)");

      // Toggle 10 consecutive times
      for (let i = 1; i <= 10; i++) {
        headerTitleBox.props.onMouseUp();

        if (i % 2 === 1) {
          // Folded state: mainBodyBox is hidden (visible: false)
          expect(mainBodyBox.visible).toBe(false);
          expect(headerText.props.content).toContain("▶ 🧠 Memory Graph (5)");
        } else {
          // Unfolded state: mainBodyBox is visible
          expect(mainBodyBox.visible).toBe(true);
          expect(headerText.props.content).toContain("▼ 🧠 Memory Graph (5)");
        }
      }

      // Final check after 10 toggles: tree is permanently intact with exactly 2 children
      expect(rootBox.getChildren()).toHaveLength(2);
      expect(mainBodyBox.visible).toBe(true);
    });

    it("[● ON] / [○ OFF] Toggle Button: updates disk JSON and visual styles accurately", () => {
      const mockApi = createMockApi();
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => Object.assign(node.props, props),
        createSignal: (v: any) => [() => v, () => {}],
        onCleanup: (fn: any) => cleanups.push(fn),
      };

      const rootBox = createSidebarMemoryWidget(mockApi, solid, { session_id: sid });
      const [headerBox] = rootBox.getChildren();
      const [, sessionToggleBox] = headerBox.getChildren();
      const [sessionToggleText] = sessionToggleBox.getChildren();

      // Initial state is ON
      expect(sessionToggleText.props.content).toBe(" [● ON]");
      expect(sessionToggleText.props.fg).toBe(mockApi.theme.current.success);

      // 1. Click to turn OFF
      sessionToggleBox.props.onMouseUp();

      // Verify disk state
      const stateOff = readSessionState(sid);
      expect(stateOff.enabled).toBe(false);

      // Verify UI node state
      expect(sessionToggleText.props.content).toBe(" [○ OFF]");
      expect(sessionToggleText.props.fg).toBe(mockApi.theme.current.textMuted);
      expect(mockApi.ui.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variant: "warning",
          message: "Memory recall disabled for this session",
        }),
      );

      // 2. Click to turn back ON
      sessionToggleBox.props.onMouseUp();

      const stateOn = readSessionState(sid);
      expect(stateOn.enabled).toBe(true);
      expect(sessionToggleText.props.content).toBe(" [● ON]");
      expect(sessionToggleText.props.fg).toBe(mockApi.theme.current.success);
      expect(mockApi.ui.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variant: "info",
          message: "Memory recall enabled for this session",
        }),
      );
    });

    it("Sub-accordions (LAST RECALL and SESSION RECALLS): fold and unfold independently and together without DOM leaks", () => {
      const mockApi = createMockApi();
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => Object.assign(node.props, props),
        createSignal: (v: any) => [() => v, () => {}],
        onCleanup: (fn: any) => cleanups.push(fn),
      };

      const rootBox = createSidebarMemoryWidget(mockApi, solid, { session_id: sid });
      const [, mainBodyBox] = rootBox.getChildren();
      const [lastRecallContainer, historyContainer] = mainBodyBox.getChildren();

      // Check initial state: both have header + body (2 children each)
      expect(lastRecallContainer.getChildren()).toHaveLength(2);
      expect(historyContainer.getChildren()).toHaveLength(2);

      const [lastRecallHeaderBox, lastRecallBodyBox] = lastRecallContainer.getChildren();
      const [lastRecallHeaderText] = lastRecallHeaderBox.getChildren();

      const [historyHeaderBox, historyBodyBox] = historyContainer.getChildren();
      const [historyHeaderText] = historyHeaderBox.getChildren();

      expect(lastRecallHeaderText.props.content).toContain("▼ LAST RECALL (2)");
      expect(historyHeaderText.props.content).toContain("▼ SESSION RECALLS (3)");

      // 1. Fold LAST RECALL separately
      lastRecallHeaderBox.props.onMouseUp();
      expect(lastRecallBodyBox.visible).toBe(false);
      expect(lastRecallHeaderText.props.content).toContain("▶ LAST RECALL (2)");
      expect(historyBodyBox.visible).toBe(true);

      // Unfold LAST RECALL back
      lastRecallHeaderBox.props.onMouseUp();
      expect(lastRecallBodyBox.visible).toBe(true);
      expect(lastRecallHeaderText.props.content).toContain("▼ LAST RECALL (2)");

      // 2. Fold SESSION RECALLS separately
      historyHeaderBox.props.onMouseUp();
      expect(historyBodyBox.visible).toBe(false);
      expect(historyHeaderText.props.content).toContain("▶ SESSION RECALLS (3)");
      expect(lastRecallBodyBox.visible).toBe(true);

      // Unfold SESSION RECALLS back
      historyHeaderBox.props.onMouseUp();
      expect(historyBodyBox.visible).toBe(true);
      expect(historyHeaderText.props.content).toContain("▼ SESSION RECALLS (3)");

      // 3. Fold BOTH TOGETHER
      lastRecallHeaderBox.props.onMouseUp();
      historyHeaderBox.props.onMouseUp();
      expect(lastRecallBodyBox.visible).toBe(false);
      expect(historyBodyBox.visible).toBe(false);
      expect(lastRecallHeaderText.props.content).toContain("▶ LAST RECALL (2)");
      expect(historyHeaderText.props.content).toContain("▶ SESSION RECALLS (3)");

      // 4. Unfold BOTH TOGETHER
      lastRecallHeaderBox.props.onMouseUp();
      historyHeaderBox.props.onMouseUp();
      expect(lastRecallBodyBox.visible).toBe(true);
      expect(historyBodyBox.visible).toBe(true);
      expect(lastRecallHeaderText.props.content).toContain("▼ LAST RECALL (2)");
      expect(historyHeaderText.props.content).toContain("▼ SESSION RECALLS (3)");
    });

    it("Memory Row Muting: performs strict in-place visual update without altering DOM node count", () => {
      const mockApi = createMockApi();
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => Object.assign(node.props, props),
        createSignal: (v: any) => [() => v, () => {}],
        onCleanup: (fn: any) => cleanups.push(fn),
      };

      const rootBox = createSidebarMemoryWidget(mockApi, solid, { session_id: sid });
      const [, mainBodyBox] = rootBox.getChildren();
      const [lastRecallContainer] = mainBodyBox.getChildren();
      const [, lastRecallBodyBox] = lastRecallContainer.getChildren();

      // Children: 2 memory rows + 1 tokens text row = 3 nodes
      const initialChildrenCount = lastRecallBodyBox.getChildren().length;
      expect(initialChildrenCount).toBe(3);

      const firstRow = lastRecallBodyBox.getChildren()[0];
      const [dotBox, titleBox] = firstRow.getChildren();
      const [statusDot] = dotBox.getChildren();
      const [titleText] = titleBox.getChildren();

      // Initial unmuted state
      expect(statusDot.props.content).toBe("●");
      expect(statusDot.props.fg).toBe(mockApi.theme.current.success);
      expect(titleText.props.fg).toBe(mockApi.theme.current.text);

      // Click dot to MUTE
      dotBox.props.onMouseUp();

      // 1. Verify disk update
      const stateMuted = readSessionState(sid);
      expect(stateMuted.mutedIds).toContain("m-1");

      // 2. Verify in-place visual changes
      expect(statusDot.props.content).toBe("○");
      expect(statusDot.props.fg).toBe(mockApi.theme.current.textMuted);
      expect(titleText.props.fg).toBe(mockApi.theme.current.textMuted);
      expect(mockApi.ui.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "Memory Muted",
          variant: "warning",
        }),
      );

      // 3. VITAL CHECK: DOM node count must NOT have changed (zero DOM re-renders)
      expect(lastRecallBodyBox.getChildren().length).toBe(initialChildrenCount);

      // Click dot to UNMUTE
      dotBox.props.onMouseUp();

      const stateUnmuted = readSessionState(sid);
      expect(stateUnmuted.mutedIds).not.toContain("m-1");
      expect(statusDot.props.content).toBe("●");
      expect(statusDot.props.fg).toBe(mockApi.theme.current.success);
      expect(titleText.props.fg).toBe(mockApi.theme.current.text);
      expect(mockApi.ui.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "Memory Restored",
          variant: "info",
        }),
      );

      // DOM count is still strictly identical
      expect(lastRecallBodyBox.getChildren().length).toBe(initialChildrenCount);
    });

    it("Memory Detail Dialog: displays title, importance, and snippet on click", () => {
      const mockApi = createMockApi();
      const item = {
        id: "m-test-dialog",
        title: "Test Architecture Decision",
        snippet: "Use SQLite over PostgreSQL for local simplicity",
        importance_score: 0.92,
      };

      showMemoryDetailDialog(mockApi, item);

      expect(mockApi.ui.dialog.replace).toHaveBeenCalled();
      expect(mockApi.ui.DialogAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Memory: Test Architecture Decision",
          message: expect.stringContaining("ID: m-test-dialog"),
        }),
      );
      const dialogCall = mockApi.ui.DialogAlert.mock.calls[0][0];
      expect(dialogCall.message).toContain("Importance: 0.92");
      expect(dialogCall.message).toContain("Use SQLite over PostgreSQL");

      // Test confirm clears dialog
      dialogCall.onConfirm();
      expect(mockApi.ui.dialog.clear).toHaveBeenCalled();
    });

    it("showMemoryStatsDialog(): shows active count and database path in modal", () => {
      const mockApi = createMockApi();
      showMemoryStatsDialog(mockApi);

      expect(mockApi.ui.dialog.replace).toHaveBeenCalled();
      expect(mockApi.ui.DialogAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "MCP Memory Graph Status",
          message: expect.stringContaining("Active Memories: 5"),
        }),
      );
      const dialogCall = mockApi.ui.DialogAlert.mock.calls[0][0];
      expect(dialogCall.message).toContain("Storage Engine: SQLite (Local-First)");
      expect(dialogCall.message).toContain(`Database: ${tempDbPath}`);

      dialogCall.onConfirm();
      expect(mockApi.ui.dialog.clear).toHaveBeenCalled();
    });

    it("Empty States: renders fallback placeholders when no recalls are present", () => {
      const emptySid = "session-empty";
      saveSessionState(emptySid, {
        enabled: true,
        mutedIds: [],
        history: [],
      });

      const mockApi = createMockApi();
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => Object.assign(node.props, props),
        createSignal: (v: any) => [() => v, () => {}],
        onCleanup: (fn: any) => cleanups.push(fn),
      };

      const rootBox = createSidebarMemoryWidget(mockApi, solid, { session_id: emptySid });
      const [, mainBodyBox] = rootBox.getChildren();
      const [lastRecallContainer, historyContainer] = mainBodyBox.getChildren();

      const [, lastRecallBodyBox] = lastRecallContainer.getChildren();
      const [, historyBodyBox] = historyContainer.getChildren();

      // Last recall empty placeholder
      expect(lastRecallBodyBox.getChildren()).toHaveLength(1);
      const lrEmptyText = lastRecallBodyBox.getChildren()[0];
      expect(lrEmptyText.props.content).toBe("  (none in last turn)");

      // History empty placeholder
      expect(historyBodyBox.getChildren()).toHaveLength(1);
      const histEmptyText = historyBodyBox.getChildren()[0];
      expect(histEmptyText.props.content).toBe("  (no recalls yet)");
    });

    it("Event Bus & Lifecycle: responds to message.updated, session.prompt, session.idle and disposes listeners onCleanup", () => {
      const mockApi = createMockApi();
      let cleanupHook: (() => void) | null = null;
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => Object.assign(node.props, props),
        createSignal: (v: any) => [() => v, () => {}],
        onCleanup: (fn: any) => {
          cleanupHook = fn;
        },
      };

      const rootBox = createSidebarMemoryWidget(mockApi, solid, { session_id: sid });
      const [headerBox] = rootBox.getChildren();
      const [headerTitleBox] = headerBox.getChildren();
      const [headerText] = headerTitleBox.getChildren();

      // Initial count is 5
      expect(headerText.props.content).toContain("Memory Graph (5)");

      // Verify event listeners were attached
      expect(mockApi.event.on).toHaveBeenCalledWith("message.updated", expect.any(Function));
      expect(mockApi.event.on).toHaveBeenCalledWith("session.prompt", expect.any(Function));
      expect(mockApi.event.on).toHaveBeenCalledWith("session.idle", expect.any(Function));

      // 1. Add memory to SQLite and emit message.updated
      const db = new Database(tempDbPath);
      db.prepare("INSERT INTO memories VALUES ('m-6', null, null, null, 'New Memory 6', 'Content 6')").run();
      db.close();

      mockApi.event.emit("message.updated", {
        properties: { info: { time: { completed: true } } },
      });
      // Header count should now be updated to 6
      expect(headerText.props.content).toContain("Memory Graph (6)");

      // 2. Add another memory and emit session.prompt
      const db2 = new Database(tempDbPath);
      db2.prepare("INSERT INTO memories VALUES ('m-7', null, null, null, 'New Memory 7', 'Content 7')").run();
      db2.close();

      mockApi.event.emit("session.prompt");
      expect(headerText.props.content).toContain("Memory Graph (7)");

      // 3. Add another memory and emit session.idle
      const db3 = new Database(tempDbPath);
      db3.prepare("INSERT INTO memories VALUES ('m-8', null, null, null, 'New Memory 8', 'Content 8')").run();
      db3.close();

      mockApi.event.emit("session.idle");
      expect(headerText.props.content).toContain("Memory Graph (8)");

      // Execute onCleanup
      expect(cleanupHook).toBeDefined();
      cleanupHook!();

      // Verify all listeners were unregistered
      expect(mockApi._eventListeners["message.updated"]).toHaveLength(0);
      expect(mockApi._eventListeners["session.prompt"]).toHaveLength(0);
      expect(mockApi._eventListeners["session.idle"]).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Prompt Bar Mini Status Widget Tests
  // ───────────────────────────────────────────────────────────────────────────
  describe("Prompt Bar Status Widget", () => {
    it("renders formatted recall counts and adjusts color based on MCP status and activity", () => {
      const sid = "session-prompt-test";
      // Seed SQLite with 3 active memories
      const db = new Database(tempDbPath);
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          superseded_at TEXT,
          tx_expired TEXT,
          title TEXT,
          content TEXT
        );
        INSERT INTO memories VALUES
          ('m-1', null, null, null, 'Active 1', 'Content 1'),
          ('m-2', null, null, null, 'Active 2', 'Content 2'),
          ('m-3', null, null, null, 'Active 3', 'Content 3');
      `);
      db.close();

      saveSessionState(sid, {
        enabled: true,
        mutedIds: [],
        lastRecall: {
          ts: "2026-09-09T10:00:00Z",
          tokens: ["test"],
          matches: [{ id: "m-1", title: "Test", snippet: "...", importance_score: 1 }],
        },
        history: [{ id: "m-1", title: "Test", snippet: "...", importance_score: 1 }],
      });

      const mockApi = createMockApi();
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => {
          const desc = Object.getOwnPropertyDescriptors(props);
          Object.defineProperties(node.props, desc);
        },
        createSignal: (val: any) => {
          let curr = val;
          return [
            () => curr,
            (next: any) => {
              curr = typeof next === "function" ? next(curr) : next;
              return curr;
            },
          ];
        },
        onCleanup: (fn: any) => cleanups.push(fn),
      };

      const promptNode = createMemoryPromptStatus(mockApi, solid, { session_id: sid });

      expect(promptNode.type).toBe("text");
      // Format: "${sessionRecallCount} 🧠 ${dbTotalCount}" -> history: 1, db: 3
      expect(promptNode.props.content).toBe("1 🧠 3");
      // When last message had recall (lastRecall.matches > 0), fg should be warning (yellow)
      expect(promptNode.props.fg).toBe(mockApi.theme.current.warning);

      // When MCP status is disconnected, fg must be error (red)
      mockApi.state.mcp = () => [{ name: "memory", status: "disconnected" }];
      expect(promptNode.props.fg).toBe(mockApi.theme.current.error);

      // Restore MCP connection
      mockApi.state.mcp = () => [{ name: "memory", status: "connected" }];

      // When last message had no recall, fg should be textMuted (gray)
      saveSessionState(sid, {
        enabled: true,
        mutedIds: [],
        history: [{ id: "m-1", title: "Test", snippet: "...", importance_score: 1 }],
      });
      mockApi.event.emit("session.prompt");
      expect(promptNode.props.content).toBe("1 🧠 3");
      expect(promptNode.props.fg).toBe(mockApi.theme.current.textMuted);

      // When no recalls in session at all
      saveSessionState(sid, { enabled: true, mutedIds: [], history: [] });
      mockApi.event.emit("session.prompt");
      expect(promptNode.props.content).toBe("0 🧠 3");
      expect(promptNode.props.fg).toBe(mockApi.theme.current.textMuted);
    });

    it("responds to event bus updates and properly cleans up listeners onCleanup", () => {
      const sid = "session-prompt-events";
      // Seed initial SQLite with 2 memories
      const db = new Database(tempDbPath);
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          superseded_at TEXT,
          tx_expired TEXT,
          title TEXT,
          content TEXT
        );
        INSERT INTO memories VALUES
          ('m-1', null, null, null, 'Active 1', 'Content 1'),
          ('m-2', null, null, null, 'Active 2', 'Content 2');
      `);
      db.close();

      saveSessionState(sid, { enabled: true, mutedIds: [], history: [] });

      const mockApi = createMockApi();
      let cleanupHook: (() => void) | null = null;
      const solid = {
        createElement: (type: string) => createMockNode(type),
        spread: (node: any, props: any) => {
          const desc = Object.getOwnPropertyDescriptors(props);
          Object.defineProperties(node.props, desc);
        },
        createSignal: (val: any) => {
          let curr = val;
          return [
            () => curr,
            (next: any) => {
              curr = typeof next === "function" ? next(curr) : next;
              return curr;
            },
          ];
        },
        onCleanup: (fn: any) => {
          cleanupHook = fn;
        },
      };

      const promptNode = createMemoryPromptStatus(mockApi, solid, { session_id: sid });
      expect(promptNode.props.content).toBe("0 🧠 2");

      // Verify listeners attached
      expect(mockApi.event.on).toHaveBeenCalledWith("message.updated", expect.any(Function));
      expect(mockApi.event.on).toHaveBeenCalledWith("session.prompt", expect.any(Function));
      expect(mockApi.event.on).toHaveBeenCalledWith("session.idle", expect.any(Function));

      // Update state on disk: 1 memory in history & lastRecall, and add a memory to SQLite (2 -> 3)
      const db2 = new Database(tempDbPath);
      db2.prepare("INSERT INTO memories VALUES ('m-3', null, null, null, 'Active 3', 'Content 3')").run();
      db2.close();

      saveSessionState(sid, {
        enabled: true,
        mutedIds: [],
        lastRecall: {
          ts: "2026-09-09T11:00:00Z",
          tokens: ["arch"],
          matches: [{ id: "m-10", title: "Arch", snippet: "...", importance_score: 1 }],
        },
        history: [{ id: "m-10", title: "Arch", snippet: "...", importance_score: 1 }],
      });

      mockApi.event.emit("session.prompt");
      expect(promptNode.props.content).toBe("1 🧠 3");
      expect(promptNode.props.fg).toBe(mockApi.theme.current.warning);

      // Update state on disk and emit message.updated: add another memory to SQLite (3 -> 4)
      const db3 = new Database(tempDbPath);
      db3.prepare("INSERT INTO memories VALUES ('m-4', null, null, null, 'Active 4', 'Content 4')").run();
      db3.close();

      saveSessionState(sid, {
        enabled: true,
        mutedIds: [],
        lastRecall: {
          ts: "2026-09-09T11:05:00Z",
          tokens: ["arch", "db"],
          matches: [
            { id: "m-10", title: "Arch", snippet: "...", importance_score: 1 },
            { id: "m-11", title: "DB", snippet: "...", importance_score: 1 },
          ],
        },
        history: [
          { id: "m-10", title: "Arch", snippet: "...", importance_score: 1 },
          { id: "m-11", title: "DB", snippet: "...", importance_score: 1 },
        ],
      });

      mockApi.event.emit("message.updated", {
        properties: { info: { time: { completed: true } } },
      });
      expect(promptNode.props.content).toBe("2 🧠 4");
      expect(promptNode.props.fg).toBe(mockApi.theme.current.warning);

      // Cleanup
      expect(cleanupHook).toBeDefined();
      cleanupHook!();

      expect(mockApi._eventListeners["message.updated"]).toHaveLength(0);
      expect(mockApi._eventListeners["session.prompt"]).toHaveLength(0);
      expect(mockApi._eventListeners["session.idle"]).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Plugin Lifecycle & Plugin Architecture
  // ───────────────────────────────────────────────────────────────────────────
  describe("OpenCode Plugin Lifecycle", () => {
    it("initializes plugin, registers slots, command palette, and cleanup", async () => {
      const mockApi = createMockApi();

      expect(tuiPlugin.id).toBe(PLUGIN_ID);
      await tuiPlugin.tui(mockApi);

      // Slots registered: prompt bar and sidebar widget
      expect(mockApi.slots.register).toHaveBeenCalledTimes(2);

      // Verify order 250 for sidebar content
      const sidebarReg = mockApi._slotsRegistered.find((r) => r.order === 250);
      expect(sidebarReg).toBeDefined();
      expect(sidebarReg.slots.sidebar_content).toBeDefined();

      // Verify prompt bar registration
      const promptReg = mockApi._slotsRegistered.find((r) => r.slots.session_prompt_right);
      expect(promptReg).toBeDefined();
      expect(promptReg.slots.home_prompt_right).toBeDefined();

      // Verify command palette registration
      expect(mockApi.command.register).toHaveBeenCalled();
      expect(mockApi._commandsRegistered[0][0].value).toBe("memory.stats.dialog");

      // Verify lifecycle disposal registration
      expect(mockApi.lifecycle.onDispose).toHaveBeenCalled();
    });
  });
});
