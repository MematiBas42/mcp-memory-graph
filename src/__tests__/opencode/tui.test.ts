import { describe, it, expect, vi } from "vitest";

// Mock @opentui/solid and solid-js before importing tuiPlugin
vi.mock("@opentui/solid", () => ({
  createElement: (type: string) => {
    const children: any[] = [];
    return {
      type,
      props: {},
      parent: null,
      getChildren: () => children,
      add: (c: any) => {
        c.parent = this;
        children.push(c);
      },
      remove: (c: any) => {
        c.parent = null;
        const i = children.indexOf(c);
        if (i !== -1) children.splice(i, 1);
      },
    };
  },
  spread: (node: any, props: any) => {
    Object.defineProperties(node.props, Object.getOwnPropertyDescriptors(props));
  },
}));

vi.mock("solid-js", () => ({
  createSignal: (val: any) => {
    let curr = val;
    return [() => curr, (next: any) => { curr = typeof next === "function" ? next(curr) : next; }];
  },
  onCleanup: vi.fn(),
}));

import tuiPlugin from "../../opencode/tui.js";

describe("OpenCode TUI Plugin", () => {
  it("exports valid TUI plugin module shape", () => {
    expect(tuiPlugin).toBeDefined();
    expect(tuiPlugin.id).toBe("mcp-memory-graph.status");
    expect(typeof tuiPlugin.tui).toBe("function");
  });

  it("registers slots and commands when initialized", async () => {
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
          commandsRegistered.push(factory());
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
        dialog: { replace: vi.fn(), clear: vi.fn() },
        DialogAlert: vi.fn(),
      },
    };

    await tuiPlugin.tui(mockApi);

    // Prompt slots and sidebar content slot should be registered
    expect(mockApi.slots.register).toHaveBeenCalledTimes(2);

    // Verify prompt bar registration
    const promptReg = slotsRegistered.find((r) => r.slots.session_prompt_right);
    expect(promptReg).toBeDefined();

    // Test creating prompt status
    const promptNode = promptReg.slots.session_prompt_right({}, { session_id: "test-session-nonexistent" });
    expect(promptNode).toBeDefined();
    expect(promptNode.type).toBe("text");
    expect(promptNode.props.content).toBe("0 🧠 0");
    expect(promptNode.props.fg).toBe("#888888");

    // Verify home_prompt_right renders pattern (uses global.json which has matches > 0)
    const homeNode = promptReg.slots.home_prompt_right({}, {});
    expect(homeNode).toBeDefined();
    expect(homeNode.type).toBe("text");
    expect(homeNode.props.content).toMatch(/^\d+ 🧠 \d+$/);
    expect(homeNode.props.fg).toBe("#ffff00");

    // Test disconnected MCP status returns red
    mockApi.state.mcp = () => [{ name: "memory", status: "disconnected" }];
    expect(promptNode.props.fg).toBe("#ff0000");
    mockApi.state.mcp = () => [{ name: "memory", status: "connected" }];

    // Verify sidebar registration (order 250)
    const sidebarReg = slotsRegistered.find((r) => r.order === 250);
    expect(sidebarReg).toBeDefined();
    expect(typeof sidebarReg.slots.sidebar_content).toBe("function");

    // Test creating sidebar content
    const widget = sidebarReg.slots.sidebar_content({}, { session_id: "test-session" });
    expect(widget).toBeDefined();
    expect(widget.type).toBe("box");
    expect(widget.props.width).toBe("100%");

    // Verify widget tree structure (Header, Toggle Box, Main Body)
    const children = widget.getChildren();
    expect(children.length).toBeGreaterThanOrEqual(2);
    const headerBox = children[0];
    expect(headerBox.type).toBe("box");
    expect(headerBox.props.flexDirection).toBe("row");

    // Header has title box and toggle box
    const headerChildren = headerBox.getChildren();
    expect(headerChildren.length).toBe(2);
    const titleBox = headerChildren[0];
    const toggleBox = headerChildren[1];
    expect(typeof titleBox.props.onMouseUp).toBe("function");
    expect(typeof toggleBox.props.onMouseUp).toBe("function");

    // Test clicking toggle box toggles session memory state
    toggleBox.props.onMouseUp();
    expect(mockApi.ui.toast).toHaveBeenCalled();

    // Test clicking title box toggles main accordion without error
    titleBox.props.onMouseUp();
    titleBox.props.onMouseUp();

    // Verify sub-sections stay intact when folded/unfolded
    const mainBodyBox = children[1];
    expect(mainBodyBox.type).toBe("box");
    const sections = mainBodyBox.getChildren();
    expect(sections.length).toBe(2);
    const lastRecallSection = sections[0];
    const historySection = sections[1];

    const lrHeader = lastRecallSection.getChildren()[0];
    const histHeader = historySection.getChildren()[0];
    expect(typeof lrHeader.props.onMouseUp).toBe("function");
    expect(typeof histHeader.props.onMouseUp).toBe("function");

    // Fold both sections
    lrHeader.props.onMouseUp();
    histHeader.props.onMouseUp();

    // Headers still exist and are visible!
    expect(lastRecallSection.getChildren().length).toBeGreaterThanOrEqual(1);
    expect(historySection.getChildren().length).toBeGreaterThanOrEqual(1);

    // Unfold both sections
    lrHeader.props.onMouseUp();
    histHeader.props.onMouseUp();
    expect(lastRecallSection.getChildren().length).toBeGreaterThanOrEqual(2);
    expect(historySection.getChildren().length).toBeGreaterThanOrEqual(2);

    // Verify command registration
    expect(mockApi.command.register).toHaveBeenCalledTimes(1);
    expect(commandsRegistered[0][0].value).toBe("memory.stats.dialog");
  });
});
