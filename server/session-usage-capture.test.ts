import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionHost } from "./session-host.ts";
import { captureUsageEvent } from "./session-usage-capture.ts";
import {
  closePersistDb,
  openPersistDb,
} from "./session-persist.ts";
import { emptyUsageTotals } from "./usage-telemetry.ts";

function fakeHost(): SessionHost {
  return {
    id: "usage-session",
    role: "leader",
    model: "claude-sonnet-5",
    sessionId: "sdk-session",
    usageTotals: emptyUsageTotals(),
    totalCost: 0,
  } as SessionHost;
}

describe("captureUsageEvent", () => {
  beforeEach(() => {
    closePersistDb();
  });

  afterEach(() => {
    closePersistDb();
  });

  it("deduplicates replayed usage events before updating totals or rows", () => {
    const db = openPersistDb(":memory:");
    const host = fakeHost();
    const event = {
      kind: "usage" as const,
      source: "assistant" as const,
      messageId: "msg-1",
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheCreation: 5,
      costUSD: 0.02,
    };

    captureUsageEvent(host, event, 1);
    captureUsageEvent(host, event, 2);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM session_usage").get(),
    ).toEqual({ count: 1 });
    expect(host.usageTotals).toEqual({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheCreation: 5,
      cacheHitRate: 50 / 150,
    });
    expect(host.totalCost).toBe(0.02);
  });

  it("replaces partial assistant usage with the final values for the same message", () => {
    const db = openPersistDb(":memory:");
    const host = fakeHost();

    captureUsageEvent(host, {
      kind: "usage",
      source: "assistant",
      messageId: "msg-final",
      sdkSessionId: "sdk-session",
      input: 100,
      output: 2,
      cacheRead: 50,
      cacheCreation: 5,
    }, 1);
    captureUsageEvent(host, {
      kind: "usage",
      source: "assistant",
      messageId: "msg-final",
      sdkSessionId: "sdk-session",
      input: 100,
      output: 80,
      cacheRead: 50,
      cacheCreation: 5,
    }, 2);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM session_usage").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT output_tokens, source, message_id, usage_identity FROM session_usage").get(),
    ).toEqual({
      output_tokens: 80,
      source: "assistant",
      message_id: "msg-final",
      usage_identity: "msg-final",
    });
    expect(host.usageTotals.output).toBe(80);
  });

  it("deduplicates identity replays even when they are non-consecutive", () => {
    const db = openPersistDb(":memory:");
    const host = fakeHost();
    const replayed = {
      kind: "usage" as const,
      source: "assistant" as const,
      messageId: "msg-a",
      sdkSessionId: "sdk-session",
      input: 10,
      output: 3,
    };

    captureUsageEvent(host, replayed, 1);
    captureUsageEvent(host, {
      kind: "usage",
      source: "assistant",
      messageId: "msg-b",
      sdkSessionId: "sdk-session",
      input: 20,
      output: 4,
    }, 2);
    captureUsageEvent(host, replayed, 3);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM session_usage").get(),
    ).toEqual({ count: 2 });
    expect(host.usageTotals).toMatchObject({ input: 30, output: 7 });
  });

  it("persists result cost rows without adding their cumulative tokens to totals", () => {
    const db = openPersistDb(":memory:");
    const host = fakeHost();

    captureUsageEvent(host, {
      kind: "usage",
      source: "assistant",
      messageId: "msg-cost",
      input: 7,
      output: 2,
    }, 1);
    captureUsageEvent(host, {
      kind: "usage",
      source: "result",
      messageId: "result-1",
      input: 700,
      output: 200,
      cacheRead: 500,
      costUSD: 0.47,
    }, 2);

    expect(host.usageTotals).toMatchObject({ input: 7, output: 2, cacheRead: 0 });
    expect(host.totalCost).toBe(0.47);
    expect(
      db.prepare("SELECT source, cost_usd FROM session_usage ORDER BY created_at DESC LIMIT 1").get(),
    ).toEqual({ source: "result", cost_usd: 0.47 });
  });

  it("captures Claude minion usage with the same assistant identity path", () => {
    const db = openPersistDb(":memory:");
    const host = { ...fakeHost(), id: "minion-1", role: "minion" } as SessionHost;

    captureUsageEvent(host, {
      kind: "usage",
      source: "assistant",
      messageId: "minion-msg",
      input: 11,
      output: 5,
    }, 1);

    expect(
      db.prepare("SELECT session_key, role, source, input_tokens, output_tokens FROM session_usage").get(),
    ).toEqual({
      session_key: "minion-1",
      role: "minion",
      source: "assistant",
      input_tokens: 11,
      output_tokens: 5,
    });
  });

  it("deduplicates Codex turn_completed rows across resume re-emissions", () => {
    const db = openPersistDb(":memory:");
    const host = { ...fakeHost(), model: "gpt-5.5-codex" } as SessionHost;
    const event = {
      kind: "usage" as const,
      source: "turn_completed" as const,
      turnId: "turn-1",
      sdkSessionId: "thread-1",
      input: 1000,
      output: 90,
      cacheRead: 800,
    };

    captureUsageEvent(host, event, 1);
    captureUsageEvent(host, {
      kind: "usage",
      source: "assistant",
      messageId: "intervening",
      input: 1,
      output: 1,
    }, 2);
    captureUsageEvent(host, event, 3);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM session_usage WHERE source = 'turn_completed'").get(),
    ).toEqual({ count: 1 });
    expect(host.usageTotals).toMatchObject({ input: 1001, output: 91, cacheRead: 800 });
  });
});
