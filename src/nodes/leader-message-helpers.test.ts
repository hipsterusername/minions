import { describe, it, expect, vi, afterEach } from "vitest";
import {
  groupMessages,
  formatToolInput,
  formatToolInputDetail,
  timeAgo,
  TOOL_ICONS,
  isHiddenTool,
  shortToolName,
  toolDisplayInfo,
} from "./leader-message-helpers.ts";
import type { LeaderMessageGroup } from "./leader-message-helpers.ts";
import type { DisplayMessage } from "../sdk-messages.ts";

// ── Fixture helper ────────────────────────────────────────────────────────────

function msg(
  role: DisplayMessage["role"],
  content = "",
  extra: Partial<DisplayMessage> = {},
): DisplayMessage {
  return { id: "m-1", role, content, timestamp: 0, ...extra };
}

// ── groupMessages ─────────────────────────────────────────────────────────────

describe("groupMessages", () => {
  it("wraps a single user message in a single group", () => {
    const result = groupMessages([msg("user", "hello")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "single" });
  });

  it("collapses consecutive tool messages into one tool-group", () => {
    const messages = [
      msg("tool", "read result"),
      msg("tool", "bash result"),
    ];
    const result = groupMessages(messages);
    expect(result).toHaveLength(1);
    const group = result[0] as Extract<LeaderMessageGroup, { kind: "tool-group" }>;
    expect(group.kind).toBe("tool-group");
    expect(group.msgs).toHaveLength(2);
  });

  it("collapses consecutive thinking messages into one thinking-group", () => {
    const messages = [
      msg("thinking", "thought 1"),
      msg("thinking", "thought 2"),
      msg("thinking", "thought 3"),
    ];
    const result = groupMessages(messages);
    expect(result).toHaveLength(1);
    const group = result[0] as Extract<LeaderMessageGroup, { kind: "thinking-group" }>;
    expect(group.kind).toBe("thinking-group");
    expect(group.msgs).toHaveLength(3);
  });

  it("flushes a tool batch when a non-tool message appears", () => {
    const messages = [
      msg("tool", "t1"),
      msg("assistant", "response"),
      msg("tool", "t2"),
    ];
    const result = groupMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ kind: "tool-group" });
    expect(result[1]).toMatchObject({ kind: "single" });
    expect(result[2]).toMatchObject({ kind: "tool-group" });
  });

  it("flushes a thinking batch when tool messages start", () => {
    const messages = [
      msg("thinking", "internal"),
      msg("tool", "t1"),
    ];
    const result = groupMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "thinking-group" });
    expect(result[1]).toMatchObject({ kind: "tool-group" });
  });

  it("returns empty array for empty input", () => {
    expect(groupMessages([])).toEqual([]);
  });

  it("preserves message order within a group", () => {
    const t1 = msg("tool", "first");
    const t2 = msg("tool", "second");
    const result = groupMessages([t1, t2]);
    const group = result[0] as Extract<LeaderMessageGroup, { kind: "tool-group" }>;
    expect(group.msgs[0]).toBe(t1);
    expect(group.msgs[1]).toBe(t2);
  });
});

// ── formatToolInput ───────────────────────────────────────────────────────────

describe("formatToolInput", () => {
  it("returns null for empty input", () => {
    expect(formatToolInput("Read", {})).toBeNull();
    expect(formatToolInput("Read", undefined)).toBeNull();
  });

  it("returns file_path for file tools", () => {
    const input = { file_path: "/src/foo.ts" };
    expect(formatToolInput("Read", input)).toBe("/src/foo.ts");
    expect(formatToolInput("Write", input)).toBe("/src/foo.ts");
    expect(formatToolInput("Edit", input)).toBe("/src/foo.ts");
  });

  it("returns command for Bash", () => {
    expect(formatToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("returns pattern for Glob and Grep", () => {
    const input = { pattern: "**/*.ts" };
    expect(formatToolInput("Glob", input)).toBe("**/*.ts");
    expect(formatToolInput("Grep", input)).toBe("**/*.ts");
  });

  it("returns description for Agent, falling back to prompt", () => {
    expect(formatToolInput("Agent", { description: "do work" })).toBe("do work");
    expect(formatToolInput("Agent", { prompt: "fallback" })).toBe("fallback");
    expect(formatToolInput("Agent", { description: "desc", prompt: "p" })).toBe("desc");
  });

  it("returns url for WebFetch and query for WebSearch", () => {
    expect(formatToolInput("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(formatToolInput("WebSearch", { query: "typescript" })).toBe("typescript");
  });

  it("returns first string value for unknown tools", () => {
    expect(formatToolInput("Unknown", { foo: "bar" })).toBe("bar");
    expect(formatToolInput("Unknown", { count: 42 })).toBeNull();
  });
});

// ── formatToolInputDetail ─────────────────────────────────────────────────────

describe("formatToolInputDetail", () => {
  it("returns (no input) for empty or missing input", () => {
    expect(formatToolInputDetail({})).toBe("(no input)");
    expect(formatToolInputDetail(undefined)).toBe("(no input)");
  });

  it("formats string values as key: value", () => {
    const result = formatToolInputDetail({ file_path: "/foo.ts" });
    expect(result).toBe("file_path: /foo.ts");
  });

  it("JSON-serialises non-string values", () => {
    const result = formatToolInputDetail({ count: 3 });
    expect(result).toBe("count: 3");
  });

  it("joins multiple fields with newlines", () => {
    const result = formatToolInputDetail({ a: "x", b: "y" });
    expect(result).toBe("a: x\nb: y");
  });
});

// ── timeAgo ───────────────────────────────────────────────────────────────────

describe("timeAgo", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns seconds for differences under a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    expect(timeAgo(0)).toBe("30s ago");
  });

  it("returns minutes for differences between 1 and 59 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5 * 60 * 1000);
    expect(timeAgo(0)).toBe("5m ago");
  });

  it("returns hours for differences of 1 hour or more", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2 * 60 * 60 * 1000);
    expect(timeAgo(0)).toBe("2h ago");
  });

  it("clamps future timestamps to 0s ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    expect(timeAgo(5000)).toBe("0s ago");
  });
});

// ── TOOL_ICONS ────────────────────────────────────────────────────────────────

describe("TOOL_ICONS", () => {
  it("has an icon for common tools", () => {
    for (const tool of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"]) {
      expect(TOOL_ICONS[tool]).toBeDefined();
    }
  });
});

// ── isHiddenTool / shortToolName ────────────────────────────────────────────────

describe("isHiddenTool", () => {
  it("hides pure-plumbing bare tools", () => {
    expect(isHiddenTool("set_task_name")).toBe(true);
    expect(isHiddenTool("wait_and_continue")).toBe(true);
    expect(isHiddenTool("TodoWrite")).toBe(true);
  });

  it("hides plumbing tools delivered with an mcp__server__ prefix", () => {
    expect(isHiddenTool("mcp__task-manager__set_task_name")).toBe(true);
    expect(isHiddenTool("mcp__render-dashboard__render_set")).toBe(true);
  });

  it("keeps substantive work tools and handles nullish input", () => {
    expect(isHiddenTool("Read")).toBe(false);
    expect(isHiddenTool("Bash")).toBe(false);
    expect(isHiddenTool(undefined)).toBe(false);
    expect(isHiddenTool(null)).toBe(false);
  });
});

describe("shortToolName", () => {
  it("strips the mcp__server__ prefix", () => {
    expect(shortToolName("mcp__task-manager__assign_task")).toBe("assign_task");
  });

  it("leaves bare tool names untouched", () => {
    expect(shortToolName("Read")).toBe("Read");
  });
});

describe("toolDisplayInfo", () => {
  it("turns common Minions MCP actions into friendly labels and summaries", () => {
    expect(toolDisplayInfo("mcp__task-manager__assign_task", { title: "Fix auth" })).toMatchObject({
      label: "Launch minion",
      shortLabel: "Minion",
      kind: "delegate",
      summary: "Fix auth",
    });
    expect(toolDisplayInfo("mcp__task-manager__complete_task", { taskId: "t-1" })).toMatchObject({
      label: "Complete task",
      shortLabel: "Complete",
      kind: "review",
      summary: "t-1",
    });
  });

  it("keeps familiar labels for core file and shell tools", () => {
    expect(toolDisplayInfo("Read", { file_path: "/tmp/a.ts" })).toMatchObject({
      label: "Read file",
      shortLabel: "Read",
      kind: "file",
      summary: "/tmp/a.ts",
    });
    expect(toolDisplayInfo("Bash", { command: "pnpm test" })).toMatchObject({
      label: "Run command",
      shortLabel: "Command",
      kind: "shell",
      summary: "pnpm test",
    });
  });
});
