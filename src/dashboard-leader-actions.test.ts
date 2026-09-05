import { describe, expect, it } from "vitest";

import {
  DEFAULT_DASHBOARD_LEADER_ACTIONS,
  dashboardActionIcon,
  defaultDashboardLeaderActions,
  normalizeDashboardLeaderActions,
} from "./dashboard-leader-actions.ts";

describe("normalizeDashboardLeaderActions", () => {
  it("returns the built-in defaults when nothing is configured", () => {
    expect(normalizeDashboardLeaderActions(undefined)).toEqual(
      defaultDashboardLeaderActions(),
    );
    expect(normalizeDashboardLeaderActions({})).toEqual(
      defaultDashboardLeaderActions(),
    );
  });

  it("passes through a valid stored array, sanitizing each entry", () => {
    const actions = normalizeDashboardLeaderActions({
      dashboardLeaderActions: [
        { id: "ship", name: "Ship it", prompt: "Do the thing", icon: "rocket" },
        // Missing icon → falls back to the default icon.
        { id: "note", name: "Note", prompt: "Write it down" },
        // Invalid (blank prompt) → dropped.
        { id: "bad", name: "Bad", prompt: "   ", icon: "bug" },
      ] as never,
    });

    expect(actions).toEqual([
      { id: "ship", name: "Ship it", prompt: "Do the thing", icon: "rocket", skillIds: [] },
      { id: "note", name: "Note", prompt: "Write it down", icon: "play", skillIds: [] },
    ]);
  });

  it("dedupes ids so React keys stay stable", () => {
    const actions = normalizeDashboardLeaderActions({
      dashboardLeaderActions: [
        { id: "x", name: "One", prompt: "a", icon: "play" },
        { id: "x", name: "Two", prompt: "b", icon: "play" },
      ],
    });
    expect(actions.map((a) => a.id)).toEqual(["x", "x-2"]);
  });

  it("migrates legacy name/prompt records over the defaults", () => {
    const actions = normalizeDashboardLeaderActions({
      dashboardLeaderActionNames: { improve: "Polish" },
      dashboardLeaderActionPrompts: { improve: "Make this sharper." },
    } as never);

    // Order matches the built-in defaults; only `improve` is overridden.
    expect(actions.map((a) => a.id)).toEqual(["execute", "improve", "analyze"]);
    const improve = actions.find((a) => a.id === "improve");
    expect(improve).toMatchObject({ name: "Polish", prompt: "Make this sharper." });
  });

  it("ignores blank legacy overrides and keeps the default", () => {
    const actions = normalizeDashboardLeaderActions({
      dashboardLeaderActionNames: { execute: "   " },
    } as never);
    const execute = actions.find((a) => a.id === "execute");
    expect(execute?.name).toBe(
      DEFAULT_DASHBOARD_LEADER_ACTIONS.find((a) => a.id === "execute")?.name,
    );
  });

  it("preserves an explicitly configured array with no valid entries as empty", () => {
    expect(
      normalizeDashboardLeaderActions({
        dashboardLeaderActions: [{ id: "", name: "", prompt: "" }] as never,
      }),
    ).toEqual([]);
  });
});

describe("dashboardActionIcon", () => {
  it("resolves crew and graph to the same feature icon", () => {
    expect(dashboardActionIcon("crew")).toBe(dashboardActionIcon("graph"));
    expect(dashboardActionIcon("crew")).not.toBe(dashboardActionIcon(undefined));
  });
  it("resolves a known key and falls back for unknown or missing keys", () => {
    const known = dashboardActionIcon("play");
    const fallback = dashboardActionIcon("does-not-exist");
    expect(known).toBeDefined();
    expect(fallback).toBeDefined();
    // Unknown and undefined keys resolve to the same generic glyph.
    expect(dashboardActionIcon(undefined)).toBe(fallback);
    expect(known).not.toBe(fallback);
  });
});
