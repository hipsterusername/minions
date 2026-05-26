/**
 * Tests for the debug-mode core: persisted flag, recorder buffer
 * lifecycle, and duplicate detection.
 *
 * Each test resets module state between runs because the recorder is
 * intentionally a singleton (one per app, keyed by sessionKey).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDebugRecords,
  findDuplicateContent,
  getDebugRecords,
  isDebugEnabled,
  recordDebug,
  setDebugEnabled,
  subscribeDebugFlag,
  subscribeDebugRecorder,
} from "./debug.ts";

const SESSION = "ses-test";

beforeEach(() => {
  // Fresh localStorage + buffers for every test.
  window.localStorage.clear();
  clearDebugRecords(SESSION);
});

afterEach(() => {
  setDebugEnabled(false);
});

describe("debug flag", () => {
  it("defaults to disabled", () => {
    expect(isDebugEnabled()).toBe(false);
  });

  it("persists to localStorage when enabled", () => {
    setDebugEnabled(true);
    expect(isDebugEnabled()).toBe(true);
    expect(window.localStorage.getItem("minions:debug-mode")).toBe("1");
  });

  it("removes the localStorage entry when disabled", () => {
    setDebugEnabled(true);
    setDebugEnabled(false);
    expect(isDebugEnabled()).toBe(false);
    expect(window.localStorage.getItem("minions:debug-mode")).toBeNull();
  });

  it("notifies subscribers on flag changes", () => {
    const fn = vi.fn();
    const unsub = subscribeDebugFlag(fn);
    setDebugEnabled(true);
    setDebugEnabled(false);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, true);
    expect(fn).toHaveBeenNthCalledWith(2, false);
    unsub();
    setDebugEnabled(true);
    expect(fn).toHaveBeenCalledTimes(2); // unsub honored
  });

  it("invalidates the cached flag on cross-tab storage changes", () => {
    setDebugEnabled(true);
    expect(isDebugEnabled()).toBe(true);
    const fn = vi.fn();
    const unsub = subscribeDebugFlag(fn);

    window.localStorage.removeItem("minions:debug-mode");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "minions:debug-mode",
        oldValue: "1",
        newValue: null,
        storageArea: window.localStorage,
      }),
    );

    expect(isDebugEnabled()).toBe(false);
    expect(fn).toHaveBeenCalledWith(false);
    unsub();
  });
});

describe("recorder", () => {
  it("ignores records when debug is disabled", () => {
    recordDebug(SESSION, { source: "ws", type: "sdk_event" });
    expect(getDebugRecords(SESSION)).toHaveLength(0);
  });

  it("appends records when debug is enabled", () => {
    setDebugEnabled(true);
    recordDebug(SESSION, { source: "ws", type: "sdk_event", sdkType: "assistant" });
    recordDebug(SESSION, { source: "ws", type: "sdk_event", sdkType: "result" });
    const records = getDebugRecords(SESSION);
    expect(records).toHaveLength(2);
    expect(records[0]?.sdkType).toBe("assistant");
    expect(records[1]?.sdkType).toBe("result");
    expect(records[0]?.seq).toBe(1);
    expect(records[1]?.seq).toBe(2);
  });

  it("caps the buffer at 250 records", () => {
    setDebugEnabled(true);
    for (let i = 0; i < 300; i++) {
      recordDebug(SESSION, { source: "ws", type: "sdk_event" });
    }
    const records = getDebugRecords(SESSION);
    expect(records).toHaveLength(250);
    // Oldest dropped — earliest seq is 51 (300 - 250 + 1).
    expect(records[0]?.seq).toBe(51);
    expect(records[records.length - 1]?.seq).toBe(300);
  });

  it("notifies subscribers on each new record", () => {
    setDebugEnabled(true);
    const fn = vi.fn();
    const unsub = subscribeDebugRecorder(SESSION, fn);
    recordDebug(SESSION, { source: "ws", type: "sdk_event" });
    recordDebug(SESSION, { source: "ws", type: "sdk_event" });
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
    recordDebug(SESSION, { source: "ws", type: "sdk_event" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clearDebugRecords drops the buffer and notifies subscribers", () => {
    setDebugEnabled(true);
    const fn = vi.fn();
    subscribeDebugRecorder(SESSION, fn);
    recordDebug(SESSION, { source: "ws", type: "sdk_event" });
    expect(getDebugRecords(SESSION)).toHaveLength(1);
    clearDebugRecords(SESSION);
    expect(getDebugRecords(SESSION)).toHaveLength(0);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("findDuplicateContent", () => {
  it("returns no groups for an empty list", () => {
    expect(findDuplicateContent([])).toEqual([]);
  });

  it("ignores the legitimate assistant→result collapse", () => {
    const groups = findDuplicateContent([
      { id: "a1", role: "assistant", content: "All done." },
      { id: "r1", role: "result", content: "All done." },
    ]);
    expect(groups).toEqual([]);
  });

  it("flags two assistant bubbles with identical content", () => {
    const groups = findDuplicateContent([
      { id: "a1", role: "assistant", content: "Hello world" },
      { id: "a2", role: "assistant", content: "Hello world" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ids).toEqual(["a1", "a2"]);
    expect(groups[0]?.content).toBe("Hello world");
  });

  it("strips <!--task-name--> tags before comparing", () => {
    const groups = findDuplicateContent([
      { id: "a1", role: "assistant", content: "<!--task-name:Foo-->Done." },
      { id: "a2", role: "assistant", content: "Done." },
    ]);
    expect(groups).toHaveLength(1);
  });

  it("flags three+ matches even when one is a result", () => {
    const groups = findDuplicateContent([
      { id: "a1", role: "assistant", content: "Hi" },
      { id: "a2", role: "assistant", content: "Hi" },
      { id: "r1", role: "result", content: "Hi" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ids).toEqual(["a1", "a2", "r1"]);
  });

  it("skips empty/whitespace-only content", () => {
    const groups = findDuplicateContent([
      { id: "a1", role: "assistant", content: "   " },
      { id: "a2", role: "assistant", content: "" },
    ]);
    expect(groups).toEqual([]);
  });

  it("ignores user/system/tool roles entirely", () => {
    const groups = findDuplicateContent([
      { id: "u1", role: "user", content: "Repeat" },
      { id: "u2", role: "user", content: "Repeat" },
      { id: "s1", role: "system", content: "ping" },
      { id: "s2", role: "system", content: "ping" },
    ]);
    expect(groups).toEqual([]);
  });
});
