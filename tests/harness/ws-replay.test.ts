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
  it("loads the leader-plan-and-delegate fixture and returns 12 entries", () => {
    const entries = loadFixture("leader-plan-and-delegate.jsonl");
    // Phase 3: the old single result/success SdkMessage is now two events
    // (usage + done), so fixture is 12 entries (was 11).
    expect(entries).toHaveLength(12);

    // First entry should be the sdk_event/init.
    const first = entries[0]?.message;
    expect(first?.type).toBe("sdk_event");
    if (first?.type === "sdk_event") {
      expect(first.event.kind).toBe("init");
    }

    // Last entry should be the done NormalizedEvent.
    const last = entries.at(-1)?.message;
    expect(last?.type).toBe("sdk_event");
    if (last?.type === "sdk_event") {
      expect(last.event.kind).toBe("done");
    }
  });

  // Note: a "skips comment + blank lines" check is dropped per
  // testing-strategy.md §5.7 (TRIVIAL) — every other test in this file would
  // throw at parse time if those lines weren't skipped, so it adds no signal.

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

  // Note: a "captures send() payloads in order" check is dropped per §5.7 —
  // it tested the harness against itself (Array.push semantics).

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

  // Note: a "exposes connected/reconnect state" check is dropped per §5.7 —
  // it tested the harness's own constants. Real consumers (use-socket.ts)
  // exercise these fields through their behaviour.
});

// ── loadAndReplay (integration) ─────────────────────────

describe("loadAndReplay", () => {
  it("plays the leader-plan-and-delegate fixture end-to-end into a subscriber", async () => {
    const { socket, replay, entries } = loadAndReplay("leader-plan-and-delegate.jsonl");
    const seen: ServerMessage[] = [];
    socket.subscribe((m) => seen.push(m));

    await replay();

    expect(seen).toHaveLength(entries.length);

    // Spot-check: the set_task_name tool_call arrives before the
    // session_task_name echo. Phase 3: the tool_call is a NormalizedEvent
    // of kind "tool_call", not an SdkMessage assistant block.
    const setTaskNameIdx = seen.findIndex(
      (m) =>
        m.type === "sdk_event" &&
        m.event.kind === "tool_call" &&
        m.event.name === "mcp__task-manager__set_task_name",
    );
    const taskNameEchoIdx = seen.findIndex((m) => m.type === "session_task_name");
    expect(setTaskNameIdx).toBeGreaterThanOrEqual(0);
    expect(taskNameEchoIdx).toBeGreaterThan(setTaskNameIdx);

    // Usage event must carry the session cost.
    const usageMsg = seen.find(
      (m) =>
        m.type === "sdk_event" &&
        m.event.kind === "usage" &&
        (m.event as { costUSD?: number }).costUSD != null,
    );
    if (!usageMsg || usageMsg.type !== "sdk_event" || usageMsg.event.kind !== "usage") {
      throw new Error("expected a usage event with costUSD");
    }
    expect(usageMsg.event.costUSD).toBe(0.0288);
  });
});
