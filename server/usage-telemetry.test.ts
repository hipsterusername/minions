import { describe, expect, it } from "vitest";
import { initDb } from "./db.ts";
import {
  addUsageToTotals,
  emptyUsageTotals,
  getSessionUsageTotals,
  insertSessionUsage,
} from "./usage-telemetry.ts";

describe("usage telemetry", () => {
  it("persists per-turn rows and aggregates cache hit rate", () => {
    const db = initDb(":memory:");
    insertSessionUsage(db, {
      sessionKey: "s1",
      role: "leader",
      model: "claude-sonnet",
      source: "assistant",
      messageId: "msg-1",
      sdkSessionId: "sdk-1",
      usageIdentity: "msg-1",
      input: 100,
      output: 20,
      cacheRead: 300,
      cacheCreation: 10,
      costUSD: 0.02,
      timestamp: 1,
    });
    insertSessionUsage(db, {
      sessionKey: "s1",
      role: "leader",
      model: "claude-sonnet",
      source: "assistant",
      messageId: "msg-2",
      sdkSessionId: "sdk-1",
      usageIdentity: "msg-2",
      input: 50,
      output: 5,
      cacheRead: 50,
      timestamp: 2,
    });

    const rawRows = db
      .prepare("SELECT session_key, role, model, source, message_id, harness_session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at FROM session_usage ORDER BY created_at")
      .all();
    expect(rawRows).toHaveLength(2);
    expect(rawRows[0]).toMatchObject({
      session_key: "s1",
      role: "leader",
      model: "claude-sonnet",
      source: "assistant",
      message_id: "msg-1",
      harness_session_id: "sdk-1",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 300,
      cache_creation_tokens: 10,
      cost_usd: 0.02,
      created_at: 1,
    });

    expect(getSessionUsageTotals(db, "s1")).toEqual({
      input: 150,
      output: 25,
      cacheRead: 350,
      cacheCreation: 10,
      cacheHitRate: 0.7,
    });
    db.close();
  });

  it("increments in-memory totals from normalized usage events", () => {
    const totals = addUsageToTotals(emptyUsageTotals(), {
      kind: "usage",
      source: "assistant",
      input: 25,
      output: 5,
      cacheRead: 75,
      cacheCreation: 2,
    });

    expect(totals).toEqual({
      input: 25,
      output: 5,
      cacheRead: 75,
      cacheCreation: 2,
      cacheHitRate: 0.75,
    });
  });

  it("excludes result rows from token totals while preserving result cost rows", () => {
    const db = initDb(":memory:");
    insertSessionUsage(db, {
      sessionKey: "s1",
      role: "leader",
      model: "claude-sonnet",
      source: "assistant",
      messageId: "msg-1",
      usageIdentity: "msg-1",
      input: 10,
      output: 5,
      timestamp: 1,
    });
    insertSessionUsage(db, {
      sessionKey: "s1",
      role: "leader",
      model: "claude-sonnet",
      source: "result",
      messageId: "result-1",
      usageIdentity: "result-1",
      input: 1000,
      output: 500,
      cacheRead: 900,
      costUSD: 0.47,
      timestamp: 2,
    });

    expect(getSessionUsageTotals(db, "s1")).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheCreation: 0,
      cacheHitRate: 0,
    });
    expect(
      db.prepare("SELECT source, cost_usd FROM session_usage WHERE source = 'result'").get(),
    ).toEqual({ source: "result", cost_usd: 0.47 });
    db.close();
  });

  it("upserts rows with the same usage identity", () => {
    const db = initDb(":memory:");
    insertSessionUsage(db, {
      sessionKey: "s1",
      role: "leader",
      model: "claude-sonnet",
      source: "assistant",
      messageId: "msg-1",
      sdkSessionId: "sdk-1",
      usageIdentity: "msg-1",
      input: 10,
      output: 2,
      timestamp: 1,
    });
    insertSessionUsage(db, {
      sessionKey: "s1",
      role: "leader",
      model: "claude-sonnet",
      source: "assistant",
      messageId: "msg-1",
      sdkSessionId: "sdk-1",
      usageIdentity: "msg-1",
      input: 10,
      output: 20,
      timestamp: 2,
    });

    expect(
      db.prepare("SELECT COUNT(*) AS count, output_tokens FROM session_usage").get(),
    ).toEqual({ count: 1, output_tokens: 20 });
    db.close();
  });

  it("does not add result usage to in-memory token totals", () => {
    const totals = addUsageToTotals(emptyUsageTotals(), {
      kind: "usage",
      source: "result",
      input: 100,
      output: 50,
      cacheRead: 20,
      costUSD: 0.47,
    });

    expect(totals).toEqual(emptyUsageTotals());
  });
});
