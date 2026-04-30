/**
 * SessionHost — lifecycle tests.
 *
 * These pin the contract `SessionHost` exposes to `server/index.ts` and the
 * registry: it owns one SDK `query()` per `start()`, fans every event out
 * onto the bus wrapped as a `sdk_event`, advances `status` correctly on
 * init/result/error, and respects the abort controller.
 *
 * Boundary mocks (per docs/testing-strategy.md §5.2):
 *   - `@anthropic-ai/claude-agent-sdk.query` — replaced with a generator
 *     the test drives directly.
 *   - `./session-persist.ts` — disabled via the production `disablePersistence()`
 *     toggle so no SQLite is touched.
 *
 * Real, untouched:
 *   - `Bus` capture (the real `createBus` over a fake `WebSocketServer`
 *     that records every fan-out).
 *   - `SessionHost` itself.
 *   - The `default` agent (no MCP, no worktree) — keeps the test focused
 *     on lifecycle, not agent wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boundary mock — declared before the imports under test so vitest hoists
// the factory to module-load time.
type SdkMessage = Record<string, unknown>;
const sdkQueueRef: { queue: SdkMessage[]; aborted: boolean } = {
  queue: [],
  aborted: false,
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: () => {
      const ref = sdkQueueRef;
      return (async function* () {
        for (const msg of ref.queue) {
          if (ref.aborted) break;
          yield msg;
        }
      })();
    },
  };
});

import { SessionHost, type SessionHostDeps } from "./session-host.ts";
import { createBus, type Bus } from "./bus.ts";
import {
  disablePersistence,
  closePersistDb,
} from "./session-persist.ts";
import "./agents/index.ts"; // registers leader/minion/default

interface CapturedEnvelope {
  topic: string;
  type: string;
  payload: Record<string, unknown>;
}

interface Harness {
  host: SessionHost;
  bus: Bus;
  envelopes: CapturedEnvelope[];
  deps: SessionHostDeps;
}

function makeHarness(id = "host-1", cwd = "/tmp/fake-cwd"): Harness {
  // Fake WebSocketServer: a `clients` set that's always empty so `broadcast`
  // is a no-op. The bus's in-process `subscribe` is what carries our capture.
  const fakeWss = { clients: new Set() } as unknown as Parameters<
    typeof createBus
  >[0];
  const bus = createBus(fakeWss);

  const envelopes: CapturedEnvelope[] = [];
  bus.subscribe((env) => {
    const { topic, type, ...rest } = env as CapturedEnvelope &
      Record<string, unknown>;
    envelopes.push({ topic, type, payload: rest });
  });

  const deps: SessionHostDeps = {
    bus,
    startChildSession: vi.fn(),
    forEachLeaderTaskState: vi.fn(),
  };

  return { host: new SessionHost(id, cwd), bus, envelopes, deps };
}

beforeEach(() => {
  // Fresh queue + reset abort flag per test.
  sdkQueueRef.queue = [];
  sdkQueueRef.aborted = false;
  // Disable SQLite persistence for the duration of these tests.
  disablePersistence();
});

afterEach(() => {
  closePersistDb();
});

describe("SessionHost.start — happy-path lifecycle", () => {
  it("transitions running → idle when the SDK closes with a result event", async () => {
    const { host, deps, envelopes } = makeHarness();

    sdkQueueRef.queue = [
      { type: "system", subtype: "init", session_id: "sess-1", model: "sonnet" },
      { type: "result", total_cost_usd: 0.42, num_turns: 3 },
    ];

    await host.start(
      { sessionKey: host.id, prompt: "hello", cwd: host.cwd },
      deps,
    );

    expect(host.status).toBe("idle");
    expect(host.sessionId).toBe("sess-1");
    expect(host.totalCost).toBe(0.42);
    expect(host.turns).toBe(3);

    // The bus saw: running, sdk_event(init), sdk_event(result), idle.
    const types = envelopes.map((e) => e.type);
    expect(types).toEqual([
      "session_status", // running
      "sdk_event",
      "sdk_event",
      "session_status", // idle
    ]);

    const statuses = envelopes
      .filter((e) => e.type === "session_status")
      .map((e) => e.payload["status"]);
    expect(statuses).toEqual(["running", "idle"]);
  });

  it("captures init metadata into host.initData and persists session_id immediately", async () => {
    const { host, deps } = makeHarness();
    sdkQueueRef.queue = [
      {
        type: "system",
        subtype: "init",
        session_id: "captured-id",
        model: "sonnet",
        permissionMode: "auto",
        tools: ["Read", "Write"],
      },
      { type: "result" },
    ];

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd }, deps);

    expect(host.sessionId).toBe("captured-id");
    expect(host.permissionMode).toBe("auto");
    expect(host.initData).toMatchObject({
      tools: ["Read", "Write"],
      model: "sonnet",
    });
  });

  it("buffers every SDK event onto host.eventBuffer", async () => {
    const { host, deps } = makeHarness();
    sdkQueueRef.queue = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", text: "hello" },
      { type: "assistant", text: "world" },
      { type: "result" },
    ];

    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd }, deps);

    // running + 4 sdk_events + idle = 6 buffered events (the bus fan-out
    // is independent of the buffer; both get the same set).
    expect(host.eventBuffer.map((e) => e.type)).toEqual([
      "session_status",
      "sdk_event",
      "sdk_event",
      "sdk_event",
      "sdk_event",
      "session_status",
    ]);
  });
});

describe("SessionHost.start — error path", () => {
  it("transitions to status='error' and emits a session_error event when the SDK throws synchronously", async () => {
    const { host, deps, envelopes } = makeHarness();

    // Override the mocked query to throw on iteration.
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const original = sdk.query;
    (sdk as { query: unknown }).query = () => {
      return (async function* () {
        throw new Error("boom");
        // eslint-disable-next-line no-unreachable
        yield {} as never;
      })();
    };

    try {
      await host.start(
        { sessionKey: host.id, prompt: "p", cwd: host.cwd },
        deps,
      );
    } finally {
      (sdk as { query: unknown }).query = original;
    }

    expect(host.status).toBe("error");
    expect(host.lastError).toBe("boom");
    const errorEvents = envelopes.filter((e) => e.type === "session_error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.payload["error"]).toBe("boom");
  });

  it("preserves prior session metrics when an error occurs", async () => {
    const { host, deps } = makeHarness();
    host.totalCost = 1.23;
    host.turns = 7;

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const original = sdk.query;
    (sdk as { query: unknown }).query = () => {
      return (async function* () {
        throw new Error("network");
        // eslint-disable-next-line no-unreachable
        yield {} as never;
      })();
    };

    try {
      await host.start(
        { sessionKey: host.id, prompt: "p", cwd: host.cwd },
        deps,
      );
    } finally {
      (sdk as { query: unknown }).query = original;
    }

    expect(host.totalCost).toBe(1.23);
    expect(host.turns).toBe(7);
  });
});

describe("SessionHost.start — abort", () => {
  it("breaks out of the for-await loop when the abort controller fires mid-stream", async () => {
    const { host, deps, envelopes } = makeHarness();

    // Queue four messages but mark aborted after the second is consumed.
    let consumed = 0;
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const original = sdk.query;
    (sdk as { query: unknown }).query = () => {
      return (async function* () {
        const msgs: SdkMessage[] = [
          { type: "system", subtype: "init", session_id: "s" },
          { type: "assistant", text: "first" },
          { type: "assistant", text: "second" },
          { type: "assistant", text: "third" },
          { type: "result" },
        ];
        for (const m of msgs) {
          yield m;
          consumed += 1;
          if (consumed === 2) {
            host.abortController.abort();
          }
        }
      })();
    };

    try {
      await host.start(
        { sessionKey: host.id, prompt: "p", cwd: host.cwd },
        deps,
      );
    } finally {
      (sdk as { query: unknown }).query = original;
    }

    // We consumed init + first; then aborted; "second", "third", and
    // "result" never reached the bus.
    const sdkEvents = envelopes.filter((e) => e.type === "sdk_event");
    expect(sdkEvents).toHaveLength(2);
    // No idle status — abort short-circuits before result.
    const statuses = envelopes
      .filter((e) => e.type === "session_status")
      .map((e) => e.payload["status"]);
    expect(statuses).toEqual(["running"]);
    // status stays "running" because no result and no throw fired.
    expect(host.status).toBe("running");
  });
});

describe("SessionHost.bufferEvent — retention cap", () => {
  it("trims to the most recent MAX_BUFFERED_EVENTS when the buffer grows past the cap", async () => {
    const { host } = makeHarness();
    const { MAX_BUFFERED_EVENTS } = await import("./session-host-config.ts");

    for (let i = 0; i < MAX_BUFFERED_EVENTS + 50; i++) {
      host.bufferEvent({
        type: "sdk_event",
        sessionKey: host.id,
        message: { seq: i },
        timestamp: i,
      });
    }

    expect(host.eventBuffer).toHaveLength(MAX_BUFFERED_EVENTS);
    // Oldest 50 dropped — the first surviving entry should be seq=50.
    expect(
      (host.eventBuffer[0]?.message as { seq: number }).seq,
    ).toBe(50);
    expect(
      (host.eventBuffer.at(-1)?.message as { seq: number }).seq,
    ).toBe(MAX_BUFFERED_EVENTS + 49);
  });
});

describe("SessionHost.clearWaitTimer", () => {
  it("clears an active wait timer and is idempotent on a clean host", () => {
    const { host } = makeHarness();
    expect(host.waitTimerId).toBeNull();

    host.waitTimerId = setTimeout(() => {
      throw new Error("timer should have been cleared");
    }, 100);
    expect(host.waitTimerId).not.toBeNull();

    host.clearWaitTimer();
    expect(host.waitTimerId).toBeNull();

    // Calling on an already-clean host is a no-op.
    host.clearWaitTimer();
    expect(host.waitTimerId).toBeNull();
  });
});

describe("SessionHost.start — role + agent context", () => {
  it("uses the role passed in opts, falling back to the host's existing role", async () => {
    const { host, deps } = makeHarness();
    sdkQueueRef.queue = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result" },
    ];

    await host.start(
      { sessionKey: host.id, prompt: "p", cwd: host.cwd, role: "default" },
      deps,
    );
    expect(host.role).toBe("default");

    // No role in opts — sticks with what was set last time.
    sdkQueueRef.queue = [
      { type: "system", subtype: "init", session_id: "s2" },
      { type: "result" },
    ];
    await host.start({ sessionKey: host.id, prompt: "p2", cwd: host.cwd }, deps);
    expect(host.role).toBe("default");
  });

  it("clears the wait timer at the start of a new run", async () => {
    const { host, deps } = makeHarness();
    let timerFired = false;
    host.waitTimerId = setTimeout(() => {
      timerFired = true;
    }, 1);

    sdkQueueRef.queue = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result" },
    ];
    await host.start({ sessionKey: host.id, prompt: "p", cwd: host.cwd }, deps);

    // Wait one macrotask; if the timer survived start(), it would have fired.
    await new Promise((r) => setTimeout(r, 5));
    expect(timerFired).toBe(false);
    expect(host.waitTimerId).toBeNull();
  });
});
