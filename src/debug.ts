/**
 * Debug-mode infrastructure for the streaming/chat UI.
 *
 * Why this exists: assistant text occasionally renders as duplicate
 * strings — both during the live preview (`streamingText`) and in the
 * committed messages list. The shared `sessionStreamReducer` looks
 * correct under unit test, so the bug likely lives in the per-node
 * reducers that *don't* use it (most notably {@link import("./nodes/ClaudeSessionNode")}
 * which keeps its own ad-hoc subscription, generates random message
 * IDs via `crypto.randomUUID()`, and never deduplicates by SDK UUID).
 *
 * Catching that in the wild requires inspecting the WS event sequence
 * against the resulting state. This module provides a tiny recorder
 * + duplicate detector + pub/sub so a `<DebugInspector>` panel can
 * show the user exactly what was observed.
 *
 * Design choices:
 *   - **localStorage flag** so debug mode survives reloads.
 *   - **Per-session-key buffers** capped at {@link MAX_RECORDS_PER_SESSION}
 *     so long sessions can't blow up memory.
 *   - **Pure data on the way in** — the recorder shallow-clones a small
 *     digest of each event rather than the full SDK message, keeping
 *     buffers bounded and side-effect-free.
 *   - **Pub/sub** so React components don't poll.
 */

const STORAGE_KEY = "minions:debug-mode";
const MAX_RECORDS_PER_SESSION = 250;
let debugEnabledCache: boolean | null = null;
const flagListeners = new Set<(enabled: boolean) => void>();

function notifyDebugFlag(enabled: boolean): void {
  flagListeners.forEach((fn) => {
    try {
      fn(enabled);
    } catch {
      /* listener errors must not break siblings */
    }
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    debugEnabledCache = null;
    notifyDebugFlag(isDebugEnabled());
  });
}

// ── Public flag ─────────────────────────────────────────────

/**
 * Read the persisted debug-mode flag. Falls back to `false` outside the
 * browser (tests, SSR) so reducers don't accidentally instrument in CI.
 */
export function isDebugEnabled(): boolean {
  if (debugEnabledCache !== null) return debugEnabledCache;
  if (typeof window === "undefined") return false;
  try {
    debugEnabledCache = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    debugEnabledCache = false;
  }
  return debugEnabledCache;
}

/** Write the persisted debug-mode flag and notify subscribers. */
export function setDebugEnabled(value: boolean): void {
  debugEnabledCache = value;
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* localStorage unavailable — keep going so the in-memory listeners still fire. */
  }
  notifyDebugFlag(value);
}

/** Subscribe to debug-mode flag changes. Returns an unsubscribe fn. */
export function subscribeDebugFlag(
  fn: (enabled: boolean) => void,
): () => void {
  flagListeners.add(fn);
  return () => {
    flagListeners.delete(fn);
  };
}

/**
 * Snapshots / subscribe pair for `useSyncExternalStore`. Stable function
 * references so consumers can use them as hook dependencies safely.
 */
export const debugFlagStore = {
  subscribe(fn: () => void): () => void {
    return subscribeDebugFlag(fn);
  },
  getSnapshot(): boolean {
    return isDebugEnabled();
  },
};

// ── Recorder ────────────────────────────────────────────────

/**
 * One captured event. Intentionally a small digest — not the full SDK
 * message — so debug buffers can hold hundreds of entries without
 * pinning megabytes of payload.
 */
export interface DebugRecord {
  /** Monotonic id within this recorder. Useful as a React key. */
  seq: number;
  /** When the event was captured (ms since epoch). */
  at: number;
  /** Source of the event — `ws` for inbound, `state` for post-reducer snapshots. */
  source: "ws" | "state";
  /** Top-level WS or SDK type, e.g. `sdk_event`, `sync_response`. */
  type: string;
  /** NormalizedEvent `kind` discriminant. */
  eventKind?: string;
  /** Inner SDK message type (`assistant`, `result`, `stream_event`, …). */
  sdkType?: string;
  /** Stream event sub-type (`content_block_delta`, `message_stop`, …). */
  streamEventType?: string;
  /** Anthropic content-block index, when applicable. */
  blockIndex?: number;
  /** Length of the text delta — content is intentionally NOT recorded. */
  deltaTextLen?: number;
  /** SDK message UUID, when present. */
  uuid?: string;
  /** Sub-agent parent tool-use id, when present. */
  parentToolUseId?: string | null;
  /** Free-form note from the caller (e.g. node type). */
  note?: string;
}

interface SessionBuffer {
  /**
   * Records array — replaced (not mutated in place) on every write so
   * `useSyncExternalStore` consumers see a new reference and React
   * commits the update.
   */
  records: ReadonlyArray<DebugRecord>;
  nextSeq: number;
}

const EMPTY_RECORDS: ReadonlyArray<DebugRecord> = Object.freeze([]);
const buffers = new Map<string, SessionBuffer>();
const recorderListeners = new Map<string, Set<() => void>>();

function getBuffer(sessionKey: string): SessionBuffer {
  let buf = buffers.get(sessionKey);
  if (!buf) {
    buf = { records: EMPTY_RECORDS, nextSeq: 1 };
    buffers.set(sessionKey, buf);
  }
  return buf;
}

function notifyRecorder(sessionKey: string): void {
  const subs = recorderListeners.get(sessionKey);
  if (!subs) return;
  subs.forEach((fn) => {
    try {
      fn();
    } catch {
      /* listener errors must not break siblings */
    }
  });
}

/**
 * Append a record to the per-session buffer. No-ops if debug is off — the
 * caller doesn't need to gate.
 */
export function recordDebug(
  sessionKey: string,
  record: Omit<DebugRecord, "seq" | "at">,
): void {
  if (!isDebugEnabled()) return;
  const buf = getBuffer(sessionKey);
  const seq = buf.nextSeq++;
  const next: DebugRecord = { ...record, seq, at: Date.now() };
  const grown = [...buf.records, next];
  buf.records =
    grown.length > MAX_RECORDS_PER_SESSION
      ? grown.slice(grown.length - MAX_RECORDS_PER_SESSION)
      : grown;
  notifyRecorder(sessionKey);
}

/** Read the current record buffer for a session. */
export function getDebugRecords(sessionKey: string): ReadonlyArray<DebugRecord> {
  return buffers.get(sessionKey)?.records ?? EMPTY_RECORDS;
}

/** Subscribe to recorder updates for a single session. */
export function subscribeDebugRecorder(
  sessionKey: string,
  fn: () => void,
): () => void {
  let subs = recorderListeners.get(sessionKey);
  if (!subs) {
    subs = new Set();
    recorderListeners.set(sessionKey, subs);
  }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
    if (subs!.size === 0) recorderListeners.delete(sessionKey);
  };
}

/** Drop the buffer for a session — useful for "Clear" buttons. */
export function clearDebugRecords(sessionKey: string): void {
  const had = buffers.has(sessionKey);
  buffers.delete(sessionKey);
  if (had) notifyRecorder(sessionKey);
}

// ── Duplicate detection ─────────────────────────────────────

/** A single duplicate cluster surfaced by {@link findDuplicateContent}. */
export interface DuplicateGroup {
  /** Trimmed content shared across the cluster. */
  content: string;
  /** Display IDs of the messages that share the content. */
  ids: ReadonlyArray<string>;
  /** Roles each instance was rendered as (assistant / result / …). */
  roles: ReadonlyArray<string>;
}

/** Item shape compatible with `DisplayMessage` and `SessionMessage`. */
export interface DuplicateScanItem {
  id: string;
  role: string;
  content: string;
}

/** Tag-stripping mirror of `stripTaskNameMarker` in `session-stream.ts`. */
function normalizeForDup(s: string): string {
  return s.replace(/<!--task-name:.+?-->\s*/g, "").trim();
}

/**
 * Walk a message list and return groups of messages that share the same
 * non-empty trimmed content. The `assistant`+`result` collapse pair is
 * intentionally ignored — that's the documented SDK behaviour and the
 * reducer already handles it; we only flag *unintended* duplicates.
 */
export function findDuplicateContent(
  messages: ReadonlyArray<DuplicateScanItem>,
): DuplicateGroup[] {
  const byContent = new Map<string, DuplicateScanItem[]>();
  for (const m of messages) {
    const norm = normalizeForDup(m.content);
    if (norm.length === 0) continue;
    if (m.role !== "assistant" && m.role !== "result") continue;
    const list = byContent.get(norm);
    if (list) {
      list.push(m);
    } else {
      byContent.set(norm, [m]);
    }
  }
  const groups: DuplicateGroup[] = [];
  for (const [norm, items] of byContent.entries()) {
    if (items.length < 2) continue;
    const roles = items.map((i) => i.role);
    // Skip the legitimate assistant→result collapse (one of each, in that order).
    if (
      items.length === 2 &&
      ((roles[0] === "assistant" && roles[1] === "result") ||
        (roles[0] === "result" && roles[1] === "assistant"))
    ) {
      continue;
    }
    groups.push({
      content: norm,
      ids: items.map((i) => i.id),
      roles,
    });
  }
  return groups;
}
