import { afterEach, describe, expect, it } from "vitest";
import { openPersistDb, closePersistDb, hydrateSessionsFromDb } from "./session-persist.ts";
import { appendEvent } from "./session-repo.ts";
import { readHistoryPage, readEventChunk, readHistoricalDirectives, readHistoryPreview } from "./session-history.ts";
import { recordHistoryEvent, semanticHistory } from "./session-history-host.ts";
import { HistoryBuffer, evictHistoryCache, historyCacheStats, HISTORY_GLOBAL_BYTES, HISTORY_GLOBAL_EVENTS } from "./history-cache.ts";
import { HISTORY_PAGE_BYTES } from "../shared/history.ts";
import { SessionHost } from "./session-host.ts";
import { compileContextCheckpoint } from "./context-checkpoint.ts";
import { createBus } from "./bus.ts";
import type { WebSocketServer } from "ws";
afterEach(() => { closePersistDb(); evictHistoryCache(); });
const event = (key: string, i: number, text = "x".repeat(8000)) => ({ type: "sdk_event", sessionKey: key,
  timestamp: i, event: { kind: "text" as const, role: "assistant" as const, text, id: `${key}-${i}` } });
describe("bounded durable history", () => {
  it("excludes legacy archive-link assistant messages from checkpoint evidence", () => {
    const db = openPersistDb(":memory:");
    appendEvent(db, "s", "sdk_event", event("s", 1,
      "[Read archived event (16384 bytes)](/api/history/run-00000000-0000-4000-8000-000000000001/events/42)"));
    appendEvent(db, "s", "sdk_event", event("s", 2, "Useful conclusion"));
    const checkpoint = compileContextCheckpoint(new SessionHost("s", "/tmp"), {
      trigger: "context_recovery", originalPrompt: "Continue", persist: false,
    });
    expect(checkpoint.recentEvents).toEqual(["assistant: Useful conclusion"]);
  });
  it("keeps modest live events inline using their actual persisted size", () => {
    const db = openPersistDb(":memory:");
    const original = event("s", 1, "x".repeat(12891));
    const id = appendEvent(db, "s", original.type, original);
    const retained = recordHistoryEvent({ id: "s", eventBuffer: [] }, original, id);
    expect(retained.historyRef).toBeUndefined();
    expect(retained).toEqual(readHistoryPage(db, "s").events[0]);
    const buffer = new HistoryBuffer();
    buffer.append(retained);
    expect(buffer.events).toEqual([retained]);
  });
  it("preserves archived tool identity without replaying raw output as assistant prose", () => {
    const db = openPersistDb(":memory:");
    const call = { type: "sdk_event", sessionKey: "s", timestamp: 1,
      event: { kind: "tool_call", id: "call-1", name: "exec_command", parentId: "parent-1", input: { command: "x".repeat(100_000) } } };
    const result = { ...call, timestamp: 2, event: { kind: "tool_result", callId: "call-1",
      output: { command: "pwd", aggregated_output: "RAW_TOOL_OUTPUT".repeat(10_000) }, isError: true } };
    const callId = appendEvent(db, "s", call.type, call);
    const resultId = appendEvent(db, "s", result.type, result);
    expect(readHistoryPreview(db, "s", callId, Buffer.byteLength(JSON.stringify(call))).event).toMatchObject({
      kind: "tool_call", id: "call-1", name: "exec_command", parentId: "parent-1",
    });
    const preview = readHistoryPreview(db, "s", resultId, Buffer.byteLength(JSON.stringify(result)));
    expect(preview.event).toMatchObject({ kind: "tool_result", callId: "call-1", isError: true });
    expect(JSON.stringify(preview)).not.toContain("RAW_TOOL_OUTPUT");
    appendEvent(db, "s", "sdk_event", event("s", 3, "Useful conclusion"));
    const host = new SessionHost("s", "/tmp");
    const checkpoint = compileContextCheckpoint(host, { trigger: "context_recovery", originalPrompt: "Continue", persist: false });
    expect(checkpoint.recentEvents).toEqual(["assistant: Useful conclusion"]);
    expect(semanticHistory(host)).toHaveLength(1);
    closePersistDb();
    expect(semanticHistory({ id: "s", eventBuffer: [preview] })).toEqual([]);
  });
  it("retains archived user roles and recovers their directives from canonical history", () => {
    const db = openPersistDb(":memory:");
    const original = { ...event("s", 1), event: { kind: "text", role: "user", text: "USER_OBJECTIVE".repeat(10_000) } };
    appendEvent(db, "s", original.type, original);
    expect(readHistoryPage(db, "s").events[0]?.event).toMatchObject({ kind: "text", role: "user" });
    const checkpoint = compileContextCheckpoint(new SessionHost("s", "/tmp"), {
      trigger: "context_recovery", originalPrompt: "Continue", persist: false,
    });
    expect(checkpoint.userDirectives[0]).toContain("USER_OBJECTIVE");
    expect(checkpoint.recentEvents).toEqual([]);
  });
  it("selects bounded pages before payload allocation and streams oversized exact Unicode JSON", () => {
    const db = openPersistDb(":memory:");
    const huge = event("s", 1, "😀漢字".repeat(1_000_000));
    const id = appendEvent(db, "s", huge.type, huge);
    const newest = appendEvent(db, "s", "sdk_event", event("s", 2));
    const page = readHistoryPage(db, "s");
    expect(page.events.map(e => e.historyId)).toEqual([id, newest]);
    expect(page.events[0]?.historyRef).toMatchObject({ id, bytes: Buffer.byteLength(JSON.stringify(huge)) });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(HISTORY_PAGE_BYTES);
    const chunks: Buffer[] = [];
    for (let offset = 0;;) { const chunk = readEventChunk(db, "s", id, offset)!; if (!chunk.length) break;
      expect(chunk.length).toBeLessThanOrEqual(65536); chunks.push(chunk); offset += chunk.length; }
    expect(Buffer.concat(chunks).toString()).toBe(JSON.stringify(huge));
    expect(readEventChunk(db, "another-session", id, 0)).toBeNull();
  });
  it("bounds pages containing only oversized escaped Unicode previews", () => {
    const db = openPersistDb(":memory:");
    db.transaction(() => { for (let i = 0; i < 200; i++) appendEvent(db, "s", "sdk_event", event("s", i, "\u0001漢😀".repeat(8000))); })();
    const page = readHistoryPage(db, "s");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(HISTORY_PAGE_BYTES);
    expect(page.history.before).not.toBeNull();
  });
  it("paginates contiguous IDs without gaps while new events append", () => {
    const db = openPersistDb(":memory:");
    const ids = Array.from({ length: 400 }, (_, i) => appendEvent(db, "s", "sdk_event", event("s", i)));
    const page = readHistoryPage(db, "s");
    appendEvent(db, "s", "sdk_event", event("s", 999));
    const seen = page.events.map(e => e.historyId);
    let before = page.history.before;
    while (before) { const next = readHistoryPage(db, "s", before); seen.unshift(...next.events.map(e => e.historyId)); before = next.history.before; }
    expect(seen).toEqual(ids);
  });
  it("holds global and per-session residency constant with growing archives and isolates mutable input", () => {
    const buffers = Array.from({ length: 180 }, () => new HistoryBuffer());
    for (let pass = 0; pass < 3; pass++) for (const [i, buffer] of buffers.entries()) {
      for (let j = 0; j < 80; j++) buffer.append(event(String(i), j));
      expect(Buffer.byteLength(JSON.stringify(buffer.events))).toBeLessThan(HISTORY_PAGE_BYTES + 1000);
      expect(historyCacheStats().bytes).toBeLessThanOrEqual(HISTORY_GLOBAL_BYTES);
      expect(historyCacheStats().events).toBeLessThanOrEqual(HISTORY_GLOBAL_EVENTS);
    }
    const buffer = buffers[0]!;
    const mutable = event("mutable", 1, "small"); buffer.append(mutable); mutable.event.text = "x".repeat(1_000_000);
    expect(buffer.events.at(-1)?.event).toMatchObject({ text: "small" });
  });
  it("keeps full graph, instructions, activity and handoff evidence after cache eviction", () => {
    openPersistDb(":memory:");
    const host = new SessionHost("leader", "/tmp"); host.role = "leader"; host.persist();
    host.bufferEvent({ ...event(host.id, 1, "Original objective"), event: { kind: "text", role: "user", text: "Original objective" } });
    for (let i = 2; i < 250; i++) host.bufferEvent(event(host.id, i));
    evictHistoryCache();
    expect(host.eventBuffer).toEqual([]);
    expect(host.historyFacts.lastResponseAt).toBe(249);
    expect(readHistoricalDirectives(openPersistDb(), host.id)[0]).toContain("Original objective");
    const checkpoint = compileContextCheckpoint(host, { trigger: "context_recovery", originalPrompt: "Continue", persist: false });
    expect(checkpoint.userDirectives[0]).toContain("Original objective");
    expect(checkpoint.recentEvents.length).toBeGreaterThan(0);
    const restored = hydrateSessionsFromDb(); expect(restored).toHaveLength(1); expect(restored[0]?.events).toEqual([]);
  });
  it("projects oversized live output without changing canonical provider objects", () => {
    openPersistDb(":memory:");
    const host = new SessionHost("live", "/tmp");
    const original = event("live", 1, "x".repeat(1_000_000));
    host.bufferEvent(original);
    const sent: string[] = [];
    const bus = createBus({ clients: new Set([{ readyState: 1, bufferedAmount: 0, send: (s: string) => sent.push(s) }]) } as unknown as WebSocketServer);
    let observed: unknown; bus.subscribe(envelope => { observed = envelope.event; });
    bus.emitToSession(host.id, original);
    expect(observed).toBe(original.event);
    expect(sent[0]!.length).toBeLessThan(2048);
    expect(JSON.parse(sent[0]!).historyRef.id).toBe(1);
    expect(original.event.text.length).toBe(1_000_000);
  });
});
