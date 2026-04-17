/**
 * Self-test for the WS replay harness.
 *
 * The harness itself is the foundation for every Phase 1 SessionHost
 * snapshot test. Before any node component depends on it, this file
 * proves the harness:
 *
 *   1. Loads JSONL fixtures (skipping `#` comments and blank lines).
 *   2. Rejects malformed lines with a useful error message.
 *   3. Drives subscribers in recorded order.
 *   4. Captures `send()` payloads and exposes them.
 *   5. Honours `delayMs` between messages.
 *   6. Tolerates a subscriber unsubscribing mid-flight.
 *
 * If this file goes red, every downstream snapshot test is suspect —
 * fix this first.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ServerMessage } from "../../src/use-socket.ts";
import {
  createReplaySocket,
  loadAndReplay,
  loadFixture,
  type FixtureEntry,
} from "./ws-replay.ts";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "sdk-message-streams");

/**
 * Track temporary fixture files written during error-path tests so we
 * can unlink them in afterEach. We can't write outside FIXTURES_DIR
 * because loadFixture only accepts a relative path under it.
 */
const tempFixtures = new Set<string>();

function writeTempFixture(name: string, contents: string): string {
  writeFileSync(join(FIXTURES_DIR, name), contents);
  tempFixtures.add(name);
  return name;
}

afterEach(() => {
  for (const name of tempFixtures) {
    try {
      unlinkSync(join(FIXTURES_DIR, name));
    } catch {
      // Ignore — file may have already been cleaned up.
    }
  }
  tempFixtures.clear();
});

// ── loadFixture ─────────────────────────────────────────

describe("loadFixture", () => {
  it("loads the leader-plan-and-delegate fixture and returns 11 entries", () => {
    const entries = loadFixture("leader-plan-and-delegate.jsonl");
    expect(entries).toHaveLength(11);

    // First entry should be the system/init.
    const first = entries[0]?.message;
    expect(first?.type).toBe("sdk_event");
    if (first?.type === "sdk_event") {
      expect(first.message.type).toBe("system");
    }

    // Last entry should be the result/success.
    const last = entries.at(-1)?.message;
    expect(last?.type).toBe("sdk_event");
    if (last?.type === "sdk_event") {
      expect(last.message.type).toBe("result");
    }
  });

  it("skips `#` comment lines and blank lines", () => {
    const entries = loadFixture("leader-plan-and-delegate.jsonl");
    // The fixture starts with a long comment block and one blank line
    // between sections. If those weren't skipped, parsing would throw
    // before we got here.
    expect(entries.length).toBeGreaterThan(0);
  });

  it("throws with line number on malformed JSON", () => {
    const name = writeTempFixture(
      `__bad-${process.pid}.jsonl`,
      '{"message":{"type":"error","message":"ok"}}\nthis is not json\n',
    );
    expect(() => loadFixture(name)).toThrow(/line 2 is not valid JSON/);
  });

  it("throws when a line is missing the `message` field", () => {
    const name = writeTempFixture(
      `__nomsg-${process.pid}.jsonl`,
      '{"note":"no message field"}\n',
    );
    expect(() => loadFixture(name)).toThrow(/missing required `message`/);
  });
});

// ── createReplaySocket ──────────────────────────────────

describe("createReplaySocket", () => {
  function entry(message: ServerMessage, delayMs?: number): FixtureEntry {
    return delayMs === undefined ? { message } : { message, delayMs };
  }

  it("delivers messages to subscribers in recorded order", async () => {
    const { socket, replay } = createReplaySocket();
    const received: ServerMessage[] = [];
    socket.subscribe((m) => received.push(m));

    await replay([
      entry({ type: "session_created", sessionKey: "k1" }),
      entry({ type: "session_status", sessionKey: "k1", status: "running" }),
      entry({ type: "error", message: "boom" }),
    ]);

    expect(received).toHaveLength(3);
    expect(received[0]?.type).toBe("session_created");
    expect(received[1]?.type).toBe("session_status");
    expect(received[2]?.type).toBe("error");
  });

  it("delivers to multiple subscribers", async () => {
    const { socket, replay } = createReplaySocket();
    const a: ServerMessage[] = [];
    const b: ServerMessage[] = [];
    socket.subscribe((m) => a.push(m));
    socket.subscribe((m) => b.push(m));
    expect(socket.subscriberCount).toBe(2);

    await replay([entry({ type: "error", message: "x" })]);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("returns an unsubscribe function that removes the subscriber", async () => {
    const { socket, replay } = createReplaySocket();
    const seen: ServerMessage[] = [];
    const off = socket.subscribe((m) => seen.push(m));
    expect(socket.subscriberCount).toBe(1);

    off();
    expect(socket.subscriberCount).toBe(0);

    await replay([entry({ type: "error", message: "x" })]);
    expect(seen).toHaveLength(0);
  });

  it("tolerates a subscriber unsubscribing mid-flight", async () => {
    const { socket, replay } = createReplaySocket();
    const a: ServerMessage[] = [];
    const b: ServerMessage[] = [];
    let offA: (() => void) | undefined;
    offA = socket.subscribe((m) => {
      a.push(m);
      // Unsubscribe ourselves on first message; should not affect the
      // remaining dispatch in this tick.
      offA?.();
    });
    socket.subscribe((m) => b.push(m));

    await replay([
      entry({ type: "error", message: "1" }),
      entry({ type: "error", message: "2" }),
    ]);

    // a saw exactly the first message, b saw both.
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    expect(socket.subscriberCount).toBe(1);
  });

  it("captures send() payloads in order", () => {
    const { socket } = createReplaySocket();
    socket.send({ type: "control", command: "start" });
    socket.send({ type: "control", command: "stop" });

    expect(socket.sent).toHaveLength(2);
    expect((socket.sent[0] as { command: string }).command).toBe("start");
    expect((socket.sent[1] as { command: string }).command).toBe("stop");
  });

  it("honours delayMs between messages with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const { socket, replay } = createReplaySocket();
      const seen: ServerMessage[] = [];
      socket.subscribe((m) => seen.push(m));

      const promise = replay([
        entry({ type: "error", message: "1" }, 100),
        entry({ type: "error", message: "2" }, 200),
      ]);

      // Nothing delivered yet — both have a delay before delivery.
      expect(seen).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(seen).toHaveLength(2);

      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes connected/reconnect state expected by SocketHandle consumers", () => {
    const { socket } = createReplaySocket();
    expect(socket.connected).toBe(true);
    expect(socket.reconnectState).toBe("connected");
    expect(socket.reconnectAttempt).toBe(0);
    expect(typeof socket.manualReconnect).toBe("function");
    // manualReconnect is a no-op but must exist.
    expect(() => socket.manualReconnect()).not.toThrow();
  });
});

// ── loadAndReplay (integration) ─────────────────────────

describe("loadAndReplay", () => {
  it("plays the leader-plan-and-delegate fixture end-to-end into a subscriber", async () => {
    const { socket, replay, entries } = loadAndReplay("leader-plan-and-delegate.jsonl");
    const seen: ServerMessage[] = [];
    socket.subscribe((m) => seen.push(m));

    await replay();

    expect(seen).toHaveLength(entries.length);

    // Spot-check the recorded shape: assistant tool_use for set_task_name
    // arrives before the session_task_name echo.
    const setTaskNameIdx = seen.findIndex(
      (m) =>
        m.type === "sdk_event" &&
        m.message.type === "assistant" &&
        m.message.message.content.some(
          (b) => b.type === "tool_use" && b.name === "mcp__task-manager__set_task_name",
        ),
    );
    const taskNameEchoIdx = seen.findIndex((m) => m.type === "session_task_name");
    expect(setTaskNameIdx).toBeGreaterThanOrEqual(0);
    expect(taskNameEchoIdx).toBeGreaterThan(setTaskNameIdx);

    // Final message must be a result/success carrying the cost we set.
    const last = seen.at(-1);
    if (last?.type !== "sdk_event" || last.message.type !== "result") {
      throw new Error("expected last entry to be a result sdk_event");
    }
    expect(last.message.subtype).toBe("success");
    if (last.message.subtype === "success") {
      expect(last.message.total_cost_usd).toBe(0.0288);
    }
  });
});
