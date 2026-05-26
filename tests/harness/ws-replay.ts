/// <reference types="node" />
/**
 * WebSocket replay harness for Phase 1 SessionHost extraction.
 *
 * Loads a JSONL fixture file (one ServerMessage per line) and exposes a
 * fake `useSocket`-shaped handle that node tests can subscribe to. The
 * `replay()` function pumps the fixture through every subscriber in
 * recorded order, with optional artificial delays for stream-event
 * scenarios.
 *
 * The harness is the regression net for Phase 1: capture today's
 * behaviour against a fixed message stream, refactor LeaderNode /
 * MinionNode / ClaudeSessionNode into a shared SessionHost, then
 * replay the same fixture and assert the rendered feed is unchanged.
 *
 * See `docs/refactor-test-plan.md` Phase 1 for the broader plan.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerMessage, SocketSubscribe } from "../../src/use-socket.ts";
import { GLOBAL_TOPIC, sessionTopic, topicMatches } from "../../shared/ws-envelope.ts";

/**
 * One entry in a fixture JSONL file. Each line of the file parses to
 * one of these. The `delayMs` and `note` fields are optional fixture
 * metadata — they are stripped before the message is delivered.
 */
export interface FixtureEntry {
  /** The actual server-side message that would arrive over the WS. */
  message: ServerMessage;
  /** Optional delay before delivery (ms). Useful for stream tests. */
  delayMs?: number;
  /** Optional human-readable note for fixture authors. Ignored at runtime. */
  note?: string;
}

/** A subscriber in the same shape `useSocket().subscribe()` expects. */
export type ReplaySubscriber = (msg: ServerMessage) => void;

/**
 * The fake socket handle returned by `createReplaySocket`. Mirrors the
 * subset of `SocketHandle` that Leader/Minion/ClaudeSession nodes
 * actually consume today. Sends are captured into `sent` so tests can
 * assert on outbound traffic.
 */
export interface ReplaySocket {
  connected: boolean;
  reconnectState: "connected";
  reconnectAttempt: 0;
  manualReconnect: () => void;
  send: (data: unknown) => void;
  subscribe: SocketSubscribe;
  /** All payloads passed to `send()`, in order. */
  readonly sent: ReadonlyArray<unknown>;
  /** All currently-registered subscribers. Exposed for assertions. */
  readonly subscriberCount: number;
}

/**
 * Load a JSONL fixture from `tests/fixtures/sdk-message-streams/<name>`.
 * Each non-empty, non-comment line must parse to a `FixtureEntry`.
 *
 * Lines starting with `#` are treated as comments and skipped.
 * Trailing newlines and blank lines are ignored.
 *
 * @throws if a line is malformed JSON or missing the `message` field.
 */
export function loadFixture(relativePath: string): FixtureEntry[] {
  const root = resolve(import.meta.dirname, "..", "fixtures", "sdk-message-streams");
  const fullPath = resolve(root, relativePath);
  const raw = readFileSync(fullPath, "utf8");

  const entries: FixtureEntry[] = [];
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line || line.startsWith("#")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Fixture ${relativePath}: line ${i + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }

    if (!isFixtureEntry(parsed)) {
      throw new Error(
        `Fixture ${relativePath}: line ${i + 1} is missing required \`message\` field`,
      );
    }
    entries.push(parsed);
  }

  return entries;
}

function isFixtureEntry(value: unknown): value is FixtureEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["message"] !== "object" || obj["message"] === null) return false;
  const msg = obj["message"] as Record<string, unknown>;
  return typeof msg["type"] === "string";
}

/**
 * Create a fake `useSocket`-shaped handle plus a `replay` helper that
 * drives the registered subscribers with the supplied fixture entries.
 *
 * Usage:
 * ```ts
 * const fixture = loadFixture("leader-plan-and-delegate.jsonl");
 * const { socket, replay } = createReplaySocket();
 * render(<LeaderNode socketSubscribe={socket.subscribe} ... />);
 * await replay(fixture);
 * // assertions on the rendered feed
 * ```
 *
 * `replay()` honours `delayMs` between messages so stream-event
 * scenarios can be exercised. With no delay the call resolves
 * synchronously after dispatching all messages.
 */
export function createReplaySocket(): {
  socket: ReplaySocket;
  replay: (entries: ReadonlyArray<FixtureEntry>) => Promise<void>;
} {
  const subscribers = new Set<{ topic: string; fn: ReplaySubscriber }>();
  const sent: unknown[] = [];

  const socket: ReplaySocket = {
    connected: true,
    reconnectState: "connected",
    reconnectAttempt: 0,
    manualReconnect: () => {
      // No-op in the harness — the socket is always "connected".
    },
    send: (data: unknown) => {
      sent.push(data);
    },
    subscribe: Object.assign(
      ((...args: [ReplaySubscriber] | [string, ReplaySubscriber]) => {
        const [topic, fn] = args.length === 1 ? ["*", args[0]] : args;
        const entry = { topic, fn };
        subscribers.add(entry);
        return () => {
          subscribers.delete(entry);
        };
      }) as SocketSubscribe,
      { supportsTopics: true as const },
    ),
    get sent(): ReadonlyArray<unknown> {
      return sent;
    },
    get subscriberCount(): number {
      return subscribers.size;
    },
  };

  const replay = async (entries: ReadonlyArray<FixtureEntry>): Promise<void> => {
    for (const entry of entries) {
      if (entry.delayMs && entry.delayMs > 0) {
        await new Promise<void>((res) => setTimeout(res, entry.delayMs));
      }
      // Snapshot subscribers in case a handler unsubscribes mid-flight.
      const snapshot = Array.from(subscribers);
      const topics = topicsForReplayMessage(entry.message);
      for (const sub of snapshot) {
        if (topics.some((topic) => topicMatches(sub.topic, topic))) {
          sub.fn(entry.message);
        }
      }
    }
  };

  return { socket, replay };
}

function topicsForReplayMessage(message: ServerMessage): string[] {
  const record = message as unknown as Record<string, unknown>;
  if (typeof record["topic"] === "string") return [record["topic"]];
  const topics: string[] = [];
  if (typeof record["sessionKey"] === "string") {
    topics.push(sessionTopic(record["sessionKey"]));
  }
  if (typeof record["leaderSessionKey"] === "string") {
    topics.push(sessionTopic(record["leaderSessionKey"]));
  }
  if (typeof record["minionSessionKey"] === "string") {
    topics.push(sessionTopic(record["minionSessionKey"]));
  }
  return topics.length > 0 ? Array.from(new Set(topics)) : [GLOBAL_TOPIC];
}

/**
 * Convenience: load a fixture and immediately wrap a fresh replay
 * socket around it. Useful for tests that don't need to interleave
 * subscription setup and replay.
 */
export function loadAndReplay(
  relativePath: string,
): {
  socket: ReplaySocket;
  replay: () => Promise<void>;
  entries: FixtureEntry[];
} {
  const entries = loadFixture(relativePath);
  const { socket, replay } = createReplaySocket();
  return { socket, replay: () => replay(entries), entries };
}
