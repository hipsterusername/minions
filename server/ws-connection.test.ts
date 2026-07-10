/**
 * Contract test for `attachConnectionListeners`.
 *
 * The original bug: `ws@8.x` emits `'error'` on the WebSocket whenever an
 * inbound frame exceeds `maxPayload` (a base64-encoded screenshot can do
 * this). With no listener, Node's EventEmitter rethrows the error and the
 * server process exits with `RangeError: Max payload size exceeded`.
 *
 * Test strategy: mock the WebSocket as an EventEmitter (`ws` extends
 * EventEmitter). Attach our listeners. Emit `'error'`. If the listener is
 * not wired, EventEmitter's default behaviour throws — `expect(...).not.toThrow`
 * locks in the contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { attachConnectionListeners } from "./ws-connection.ts";
import type { ConnectionDeps } from "./ws-connection.ts";
import type { SessionListItem } from "./session-list-item.ts";
import { emptyUsageTotals } from "./usage-telemetry.ts";

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

function makeDeps(overrides: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return {
    snapshotSessions: () => [],
    dispatch: vi.fn(),
    ...overrides,
  };
}

describe("attachConnectionListeners", () => {
  beforeEach(() => {
    // Silence the helper's console output during tests.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("does not crash when ws emits an 'error' (e.g. WS_ERR_UNSUPPORTED_MESSAGE_LENGTH)", () => {
    const ws = new FakeWs();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps());

    const err = Object.assign(new RangeError("Max payload size exceeded"), {
      code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
    });

    // EventEmitter throws on emit('error', ...) when no listener is registered.
    // If `attachConnectionListeners` ever stops wiring the error handler, this
    // expectation flips and we catch the regression.
    expect(() => ws.emit("error", err)).not.toThrow();
  });

  // Note: a "logs the error via console.warn" test was removed per
  // testing-strategy.md §5.8 (LOG_SPY) — log content is not the contract.
  // The "does not crash on error" case above already proves the listener
  // is wired.

  it("sends the session_list snapshot on attach", () => {
    const ws = new FakeWs();
    const snapshot: SessionListItem[] = [
      {
        sessionKey: "abc",
        sessionId: null,
        status: "running",
        cwd: "/tmp",
        totalCost: 0,
        turns: 0,
        usageTotals: emptyUsageTotals(),
        model: null,
        permissionMode: null,
        taskName: null,
        role: "leader",
        harness: "claude",
        harnessCapabilities: null,
        lastActivityAt: null,
        activeMinions: [],
      },
    ];
    attachConnectionListeners(
      ws as unknown as WebSocket,
      makeDeps({ snapshotSessions: () => snapshot }),
    );

    expect(ws.sent).toHaveLength(1);
    const payload = JSON.parse(ws.sent[0]!);
    expect(payload.type).toBe("session_list");
    expect(payload.sessions).toEqual(snapshot);
  });

  it("dispatches valid JSON messages through the dispatch dep", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));

    ws.emit("message", Buffer.from(JSON.stringify({ type: "list_sessions" })));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "list_sessions" }, ws);
  });

  it("returns a typed error envelope when the message is not valid JSON", () => {
    const ws = new FakeWs();
    ws.sent = []; // ignore the initial session_list send
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps());
    ws.sent = []; // discard session_list

    ws.emit("message", Buffer.from("not json {"));

    expect(ws.sent).toHaveLength(1);
    const payload = JSON.parse(ws.sent[0]!);
    expect(payload.type).toBe("error");
    expect(typeof payload.message).toBe("string");
  });
});
