import { describe, expect, it } from "vitest";

import {
  formatStatusDuration,
  reconcileStatusDurations,
  type StatusEntry,
} from "./status-duration.ts";

describe("reconcileStatusDurations", () => {
  it("carries forward since when status is unchanged", () => {
    const prev = new Map<string, StatusEntry>([
      ["node-1", { status: "running", since: 100 }],
    ]);

    const next = reconcileStatusDurations(
      prev,
      [{ id: "node-1", status: "running" }],
      500,
    );

    expect(next.get("node-1")).toEqual({ status: "running", since: 100 });
  });

  it("resets since when status changes", () => {
    const prev = new Map<string, StatusEntry>([
      ["node-1", { status: "running", since: 100 }],
    ]);

    const next = reconcileStatusDurations(
      prev,
      [{ id: "node-1", status: "idle" }],
      500,
    );

    expect(next.get("node-1")).toEqual({ status: "idle", since: 500 });
  });

  it("adds new ids with the current time", () => {
    const next = reconcileStatusDurations(
      new Map(),
      [{ id: "node-1", status: "creating" }],
      500,
    );

    expect(next.get("node-1")).toEqual({ status: "creating", since: 500 });
  });

  it("drops ids that are no longer current", () => {
    const prev = new Map<string, StatusEntry>([
      ["node-1", { status: "running", since: 100 }],
      ["node-2", { status: "idle", since: 200 }],
    ]);

    const next = reconcileStatusDurations(
      prev,
      [{ id: "node-1", status: "running" }],
      500,
    );

    expect(next.has("node-1")).toBe(true);
    expect(next.has("node-2")).toBe(false);
  });

  it("does not mutate the previous map", () => {
    const prev = new Map<string, StatusEntry>([
      ["node-1", { status: "running", since: 100 }],
      ["node-2", { status: "idle", since: 200 }],
    ]);

    const next = reconcileStatusDurations(
      prev,
      [{ id: "node-1", status: "completed" }],
      500,
    );

    expect(next).not.toBe(prev);
    expect(prev).toEqual(
      new Map<string, StatusEntry>([
        ["node-1", { status: "running", since: 100 }],
        ["node-2", { status: "idle", since: 200 }],
      ]),
    );
  });
});

describe("formatStatusDuration", () => {
  it.each([
    [1_000, 1_000, "0m"],
    [0, 59 * 60_000, "59m"],
    [0, 60 * 60_000, "1h 0m"],
    [0, 90 * 60_000, "1h 30m"],
    [0, 24 * 60 * 60_000, "1d 0h"],
  ])("formats %s to %s as %s", (since, now, expected) => {
    expect(formatStatusDuration(since, now)).toBe(expected);
  });

  it("clamps negative elapsed time to zero", () => {
    expect(formatStatusDuration(2_000, 1_000)).toBe("0m");
  });
});
