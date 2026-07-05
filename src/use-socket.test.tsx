/**
 * useSocket — DOM tests.
 *
 * Boundary mocks (per docs/testing-strategy.md §5.2):
 *   - `WebSocket` — global replaced with a controllable fake whose
 *     instances expose `triggerOpen()`, `triggerMessage(text)`,
 *     `triggerClose()`, and a `sent` history array.
 *   - `./api.ts` — `getAuthToken` and `clearAuthToken` mocked so the
 *     hook never reaches `fetch`. The token value is asserted on the
 *     resulting WebSocket URL.
 *   - `Math.random` — pinned for deterministic backoff in the
 *     reconnect tests so we can fast-forward exact ms with vi timers.
 *
 * Real (untouched):
 *   - The `useSocket` hook itself.
 *   - The `wsEnvelopeSchema` (so a malformed envelope is rejected by
 *     the real validator, not a mocked one).
 *
 * Each test mounts a minimal `Probe` component, drives the fake
 * WebSocket directly, and asserts on the hook's return value or the
 * Probe's captured subscriptions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";

vi.mock("./api.ts", () => {
  return {
    getAuthToken: vi.fn(async () => "test-token-123"),
    clearAuthToken: vi.fn(),
  };
});

import { useSocket, type ReconnectState } from "./use-socket.ts";
import { sessionTopic } from "../shared/ws-envelope.ts";
import { clearAuthToken, getAuthToken } from "./api.ts";

// ── Fake WebSocket ─────────────────────────────────────────

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  sent: string[];
  /** Test driver: simulate the connection opening. */
  triggerOpen: () => void;
  /** Test driver: deliver a message. */
  triggerMessage: (data: string) => void;
  /** Test driver: simulate close from the server side. */
  triggerClose: () => void;
}

const ALL_FAKES: FakeSocket[] = [];

class FakeWebSocket {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  url: string;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  constructor(url: string) {
    this.url = url;
    const ref = this as unknown as FakeSocket;
    ref.triggerOpen = () => {
      this.readyState = 1;
      this.onopen?.();
    };
    ref.triggerMessage = (data: string) => {
      this.onmessage?.({ data });
    };
    ref.triggerClose = () => {
      this.readyState = 3;
      this.onclose?.();
    };
    ALL_FAKES.push(ref);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

function lastFake(): FakeSocket {
  const f = ALL_FAKES.at(-1);
  if (!f) throw new Error("No FakeWebSocket has been constructed yet");
  return f;
}

beforeEach(() => {
  ALL_FAKES.length = 0;
  vi.useFakeTimers();
  // Pin Math.random so the jitter term in getBackoffDelay is exactly 0.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
    FakeWebSocket;
  (getAuthToken as unknown as ReturnType<typeof vi.fn>).mockClear();
  (getAuthToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    "test-token-123",
  );
  (clearAuthToken as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Probe component ────────────────────────────────────────

interface ProbeState {
  connected: boolean;
  reconnectState: ReconnectState;
  reconnectAttempt: number;
  send: (data: unknown) => void;
  manualReconnect: () => void;
  subscribe: ReturnType<typeof useSocket>["subscribe"];
}

function Probe({
  url,
  onState,
  onSubscribe,
}: {
  url: string;
  onState: (s: ProbeState) => void;
  onSubscribe?: (
    subscribe: ReturnType<typeof useSocket>["subscribe"],
  ) => void;
}) {
  const handle = useSocket(url);
  const [renderedOnce, setRenderedOnce] = useState(false);
  useEffect(() => {
    onState({ ...handle });
  }, [
    handle.connected,
    handle.reconnectState,
    handle.reconnectAttempt,
    handle.send,
    handle.manualReconnect,
    handle.subscribe,
  ]);
  useEffect(() => {
    if (!renderedOnce) {
      onSubscribe?.(handle.subscribe);
      setRenderedOnce(true);
    }
  }, [handle.subscribe, onSubscribe, renderedOnce]);
  return null;
}

// ── Helpers ────────────────────────────────────────────────

/** Drain the microtask queue (token fetch is async) so the WebSocket constructs. */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Tests ──────────────────────────────────────────────────

describe("useSocket — initial connection", () => {
  it("appends the auth token to the URL as a query param", async () => {
    const states: ProbeState[] = [];
    render(
      <Probe
        url="ws://localhost:3141/ws"
        onState={(s) => {
          states.push(s);
        }}
      />,
    );
    await flushAsync();

    expect(ALL_FAKES).toHaveLength(1);
    expect(lastFake().url).toBe(
      "ws://localhost:3141/ws?token=test-token-123",
    );
  });

  it("uses `&` separator when the url already has a query string", async () => {
    render(
      <Probe url="ws://localhost:3141/ws?env=dev" onState={() => {}} />,
    );
    await flushAsync();
    expect(lastFake().url).toBe(
      "ws://localhost:3141/ws?env=dev&token=test-token-123",
    );
  });

  it("transitions reconnectState to 'connected' on open", async () => {
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://localhost:3141/ws"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    expect(captured?.reconnectState).toBe("reconnecting");
    expect(captured?.connected).toBe(false);

    act(() => {
      lastFake().triggerOpen();
    });

    expect(captured?.connected).toBe(true);
    expect(captured?.reconnectState).toBe("connected");
    expect(captured?.reconnectAttempt).toBe(0);
  });
});

describe("useSocket — subscribe / topic filtering", () => {
  it("firehose subscribers receive every envelope", async () => {
    const seen: { type: string }[] = [];
    let sub:
      | ReturnType<typeof useSocket>["subscribe"]
      | null = null;
    render(
      <Probe
        url="ws://x"
        onState={() => {}}
        onSubscribe={(s) => {
          sub = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    act(() => {
      sub!((msg) => {
        seen.push({ type: msg.type });
      });
    });

    act(() => {
      lastFake().triggerMessage(
        JSON.stringify({
          topic: sessionTopic("s1"),
          type: "session_status",
          sessionKey: "s1",
          status: "running",
        }),
      );
      lastFake().triggerMessage(
        JSON.stringify({
          topic: "global",
          type: "session_list",
          sessions: [],
        }),
      );
    });

    expect(seen.map((s) => s.type)).toEqual([
      "session_status",
      "session_list",
    ]);
  });

  it("topic-scoped subscribers only receive matching envelopes", async () => {
    const seen: string[] = [];
    let sub:
      | ReturnType<typeof useSocket>["subscribe"]
      | null = null;
    render(
      <Probe
        url="ws://x"
        onState={() => {}}
        onSubscribe={(s) => {
          sub = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    act(() => {
      sub!(sessionTopic("s1"), (msg) => {
        seen.push(msg.type);
      });
    });

    act(() => {
      lastFake().triggerMessage(
        JSON.stringify({
          topic: sessionTopic("s1"),
          type: "session_status",
          sessionKey: "s1",
          status: "running",
        }),
      );
      lastFake().triggerMessage(
        JSON.stringify({
          topic: sessionTopic("s2"),
          type: "session_status",
          sessionKey: "s2",
          status: "running",
        }),
      );
      lastFake().triggerMessage(
        JSON.stringify({
          topic: "global",
          type: "session_list",
          sessions: [],
        }),
      );
    });

    expect(seen).toEqual(["session_status"]);
  });

  it("unsubscribe stops further delivery", async () => {
    const seen: string[] = [];
    let sub:
      | ReturnType<typeof useSocket>["subscribe"]
      | null = null;
    render(
      <Probe
        url="ws://x"
        onState={() => {}}
        onSubscribe={(s) => {
          sub = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    let unsubscribe = () => {};
    act(() => {
      unsubscribe = sub!((m) => seen.push(m.type));
    });

    act(() => {
      lastFake().triggerMessage(
        JSON.stringify({
          topic: "global",
          type: "session_list",
          sessions: [],
        }),
      );
    });
    expect(seen).toEqual(["session_list"]);

    act(() => {
      unsubscribe();
      lastFake().triggerMessage(
        JSON.stringify({
          topic: "global",
          type: "session_list",
          sessions: [],
        }),
      );
    });
    expect(seen).toEqual(["session_list"]);
  });

  it("rejects messages whose envelope fails schema validation", async () => {
    const seen: string[] = [];
    let sub:
      | ReturnType<typeof useSocket>["subscribe"]
      | null = null;
    render(
      <Probe
        url="ws://x"
        onState={() => {}}
        onSubscribe={(s) => {
          sub = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());
    act(() => {
      sub!((m) => seen.push(m.type));
    });

    // Suppress the warn the hook emits for invalid envelopes.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    act(() => {
      // Missing `type` (schema-invalid)
      lastFake().triggerMessage(
        JSON.stringify({ topic: "global", payload: "nope" }),
      );
      // Missing `topic` (schema-invalid)
      lastFake().triggerMessage(
        JSON.stringify({ type: "session_list", sessions: [] }),
      );
      // Malformed JSON entirely
      lastFake().triggerMessage("not json {");
    });

    expect(seen).toEqual([]);
    warn.mockRestore();
  });
});

describe("useSocket — send", () => {
  it("serialises and forwards data when the socket is OPEN", async () => {
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://x"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    act(() => {
      captured!.send({ type: "ping", id: 1 });
    });

    expect(lastFake().sent).toEqual([
      JSON.stringify({ type: "ping", id: 1 }),
    ]);
  });

  it("queues messages sent before the socket is OPEN and flushes them in order on open", async () => {
    // Regression: tapping "Launch leader" fires `create_session` while the
    // socket may still be CONNECTING. Previously the message was dropped and
    // the session never started; now it is queued and flushed on open.
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://x"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    // Socket constructed but not opened → readyState stays CONNECTING.

    act(() => {
      captured!.send({ type: "create_session", id: 1 });
      captured!.send({ type: "sync_session", id: 2 });
    });

    // Nothing leaves the wire while the socket is closed.
    expect(lastFake().sent).toEqual([]);

    act(() => {
      lastFake().triggerOpen();
    });

    // The queue flushes in the order the messages were enqueued.
    expect(lastFake().sent).toEqual([
      JSON.stringify({ type: "create_session", id: 1 }),
      JSON.stringify({ type: "sync_session", id: 2 }),
    ]);
  });

  it("flushes a message queued during a reconnect window once the socket reopens", async () => {
    // The mobile failure mode: the connection drops, the user taps launch
    // during the backoff window, and the command must survive to the next open.
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://x"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    // Connection drops → we're now in reconnect backoff.
    act(() => lastFake().triggerClose());
    act(() => {
      captured!.send({ type: "create_session", id: 7 });
    });

    // Advance past the first backoff (2000ms) so a fresh socket constructs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => lastFake().triggerOpen());

    expect(lastFake().sent).toEqual([
      JSON.stringify({ type: "create_session", id: 7 }),
    ]);
  });

  it("caps the offline queue, dropping the oldest messages when it overflows", async () => {
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://x"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Enqueue 101 messages while CONNECTING; the cap is 100, so the very
    // first message is evicted and the rest are retained newest-first-out.
    act(() => {
      for (let i = 0; i < 101; i++) {
        captured!.send({ type: "msg", id: i });
      }
    });
    expect(warn).toHaveBeenCalled();

    act(() => lastFake().triggerOpen());

    const sent = lastFake().sent;
    expect(sent).toHaveLength(100);
    expect(sent[0]).toBe(JSON.stringify({ type: "msg", id: 1 }));
    expect(sent.at(-1)).toBe(JSON.stringify({ type: "msg", id: 100 }));
    warn.mockRestore();
  });
});

describe("useSocket — auto-reconnect", () => {
  it("schedules a reconnect with exponential backoff on close", async () => {
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://x"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    // Simulate disconnect.
    act(() => {
      lastFake().triggerClose();
    });
    expect(captured?.connected).toBe(false);
    expect(captured?.reconnectState).toBe("reconnecting");
    expect(captured?.reconnectAttempt).toBe(1);
    // The hook clears the cached auth token so the next connect refetches.
    expect(clearAuthToken).toHaveBeenCalled();

    // First retry: exponential = 2000ms * 2^0 = 2000ms; jitter = 0 (random
    // 0.5 → (0.5*2-1)*500 = 0).
    expect(ALL_FAKES).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ALL_FAKES).toHaveLength(2);
  });

  it("transitions to 'failed' after MAX_RECONNECT_ATTEMPTS and stops retrying", async () => {
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://x"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    // Drive 10 close cycles WITHOUT re-opening between them. Each onopen
    // would reset attemptRef to 0; we want to accumulate attempts toward
    // MAX_RECONNECT_ATTEMPTS = 10. The hook constructs a new socket on
    // each backoff retry, which we close again immediately.
    for (let i = 0; i < 10; i++) {
      act(() => {
        lastFake().triggerClose();
      });
      if (captured?.reconnectState === "failed") break;
      // Advance past the longest possible backoff (capped at 30s).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(captured?.reconnectState).toBe("failed");
    const fakeCountAtFailure = ALL_FAKES.length;

    // Further timer advancement should not produce another connection.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(ALL_FAKES.length).toBe(fakeCountAtFailure);
  });
});

describe("useSocket — manualReconnect", () => {
  it("resets attempt counter, closes existing socket without scheduling auto-retry, and connects fresh", async () => {
    let captured = null as ProbeState | null;
    render(
      <Probe
        url="ws://x"
        onState={(s) => {
          captured = s;
        }}
      />,
    );
    await flushAsync();
    act(() => lastFake().triggerOpen());

    // Drive a few reconnect cycles to get the attempt counter > 0.
    act(() => lastFake().triggerClose());
    expect(captured?.reconnectAttempt).toBe(1);

    // Advance past one backoff to surface a second fake.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
    });
    const fakesBefore = ALL_FAKES.length;

    // Manually reconnect — this should NOT cause a duplicate auto-retry
    // scheduled by the close handler. Counter resets to 0.
    await act(async () => {
      captured!.manualReconnect();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(captured?.reconnectAttempt).toBe(0);
    expect(captured?.reconnectState).toBe("reconnecting");
    // Exactly one new fake from manualReconnect (no extra from the
    // auto-retry path that the manual close suppressed).
    expect(ALL_FAKES.length).toBe(fakesBefore + 1);
  });
});
