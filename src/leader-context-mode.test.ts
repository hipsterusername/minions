import { describe, it, expect } from "vitest";
import {
  buildLeaderContextPreamble,
  mergeContextPreamble,
  resolveContextMode,
  resolveLeaderContextItem,
  CONTEXT_MODE_MENU_OPTIONS,
} from "./leader-context-mode.ts";
import type { CanvasNode } from "./types.ts";
import type { DisplayMessage } from "./sdk-messages.ts";

function msg(role: DisplayMessage["role"], content: string): DisplayMessage {
  return { id: `${role}-${content}`, role, content, timestamp: 0 };
}

function leaderNode(
  messages: DisplayMessage[],
  taskName?: string | null,
): CanvasNode {
  return {
    id: "leader-1",
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    data: { messages, taskName },
  } as CanvasNode;
}

describe("buildLeaderContextPreamble", () => {
  it("returns null for dashboard-only or empty mode lists", () => {
    expect(buildLeaderContextPreamble(["dashboard"])).toBeNull();
    expect(buildLeaderContextPreamble([])).toBeNull();
  });

  it("returns a preamble for full mode that says thinking is included", () => {
    const preamble = buildLeaderContextPreamble(["dashboard", "full", "lean"]);

    expect(preamble).not.toBeNull();
    expect(preamble).toMatch(/thinking/i);
    expect(preamble).toMatch(/includes?/i);
  });

  it("returns a preamble for lean mode without full mode that says thinking is omitted", () => {
    const preamble = buildLeaderContextPreamble(["dashboard", "lean"]);

    expect(preamble).not.toBeNull();
    expect(preamble).toMatch(/thinking/i);
    expect(preamble).toMatch(/omitted|excluded/i);
  });
});

describe("resolveContextMode", () => {
  it("passes through lean and full", () => {
    expect(resolveContextMode("lean")).toBe("lean");
    expect(resolveContextMode("full")).toBe("full");
  });

  it("defaults undefined/unknown/dashboard to 'dashboard'", () => {
    expect(resolveContextMode(undefined)).toBe("dashboard");
    expect(resolveContextMode("dashboard")).toBe("dashboard");
    expect(resolveContextMode("garbage")).toBe("dashboard");
  });
});

describe("CONTEXT_MODE_MENU_OPTIONS", () => {
  it("lists exactly the three context modes in display order", () => {
    expect(CONTEXT_MODE_MENU_OPTIONS.map((o) => o.type)).toEqual([
      "dashboard",
      "lean",
      "full",
    ]);
    expect(CONTEXT_MODE_MENU_OPTIONS.map((o) => o.label)).toEqual([
      "Dashboard",
      "Lean",
      "Full",
    ]);
  });

  it("every option type round-trips through resolveContextMode", () => {
    for (const opt of CONTEXT_MODE_MENU_OPTIONS) {
      expect(resolveContextMode(opt.type)).toBe(opt.type);
    }
  });
});

describe("mergeContextPreamble", () => {
  it("returns the base prefix unchanged when no lean/full context is incoming", () => {
    expect(mergeContextPreamble(["dashboard"], "BASE")).toBe("BASE");
    expect(mergeContextPreamble([], undefined)).toBeUndefined();
    expect(mergeContextPreamble([], null)).toBeNull();
  });

  it("prepends the preamble ahead of an existing prefix", () => {
    const merged = mergeContextPreamble(["full"], "BASE PREFIX");
    expect(merged).toMatch(/thinking/i);
    expect(merged?.endsWith("BASE PREFIX")).toBe(true);
    expect(merged).toContain("\n\n");
  });

  it("uses the preamble alone when there is no base prefix", () => {
    const merged = mergeContextPreamble(["lean"], undefined);
    expect(merged).not.toBeNull();
    expect(merged).toMatch(/thinking/i);
    expect(merged).not.toContain("BASE");
  });
});

describe("resolveLeaderContextItem", () => {
  const mixed: DisplayMessage[] = [
    msg("user", "do the thing"),
    msg("thinking", "secret plan"),
    msg("tool", "ran a tool"),
    msg("assistant", "done"),
  ];

  it("returns null for the dashboard mode (caller falls back to default extractor)", () => {
    expect(resolveLeaderContextItem(leaderNode(mixed), "dashboard")).toBeNull();
  });

  it("lean mode forwards user+assistant, excludes thinking and tools", () => {
    const item = resolveLeaderContextItem(leaderNode(mixed), "lean");
    expect(item).not.toBeNull();
    expect(item?.content).toContain("do the thing");
    expect(item?.content).toContain("done");
    expect(item?.content).not.toContain("secret plan");
    expect(item?.content).not.toContain("ran a tool");
  });

  it("full mode includes thinking but still excludes tools", () => {
    const item = resolveLeaderContextItem(leaderNode(mixed), "full");
    expect(item?.content).toContain("secret plan");
    expect(item?.content).not.toContain("ran a tool");
  });

  it("uses the leader's taskName as the label, falling back to 'Leader Session'", () => {
    expect(resolveLeaderContextItem(leaderNode(mixed, "Ship it"), "lean")?.label).toBe(
      "Ship it",
    );
    expect(resolveLeaderContextItem(leaderNode(mixed), "lean")?.label).toBe(
      "Leader Session",
    );
  });

  it("returns null when there are no forwardable messages", () => {
    expect(resolveLeaderContextItem(leaderNode([]), "full")).toBeNull();
    expect(
      resolveLeaderContextItem(leaderNode([msg("tool", "only a tool")]), "lean"),
    ).toBeNull();
  });
});
