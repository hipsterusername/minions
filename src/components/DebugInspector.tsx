/**
 * DebugInspector — drop-in panel embedded in session nodes when debug
 * mode is on.
 *
 * Surfaces three things:
 *
 *   1. Live streaming buffer state (`streamingText` length + block index)
 *      — answers "is the live preview accumulating what we expect?"
 *   2. The recent SDK event stream — answers "what did the server
 *      actually send, and in what order?"
 *   3. Duplicate-content warnings — answers "are two messages in the
 *      committed feed showing the same text?" This is the most direct
 *      way to confirm the user-visible duplicate-string bug from the UI.
 *
 * The panel is intentionally read-only: it observes state, it never
 * dispatches into the reducer.
 */

import { useMemo, useState, useSyncExternalStore } from "react";

import {
  clearDebugRecords,
  findDuplicateContent,
  getDebugRecords,
  subscribeDebugRecorder,
  type DebugRecord,
  type DuplicateScanItem,
} from "../debug.ts";

export interface DebugInspectorProps {
  /** Stable session key used to scope the recorder buffer. */
  sessionKey: string;
  /** Current live-preview text — empty when no stream is in flight. */
  streamingText: string;
  /** Anthropic content-block index of the live preview, or null. */
  streamingBlockIndex: number | null;
  /** Committed messages — shape compatible with `findDuplicateContent`. */
  messages: ReadonlyArray<DuplicateScanItem>;
  /** Optional label (e.g. "leader", "minion") rendered in the header. */
  label?: string;
}

const PANEL_BG = "var(--bg-elevated)";
const PANEL_BORDER = "var(--border-default)";
const TEXT_PRIMARY = "var(--text-primary)";
const TEXT_MUTED = "var(--text-muted)";
const TEXT_DANGER = "var(--text-danger, #d04444)";
const FONT_MONO = "var(--font-mono)";

export function DebugInspector({
  sessionKey,
  streamingText,
  streamingBlockIndex,
  messages,
  label,
}: DebugInspectorProps) {
  const records = useDebugRecords(sessionKey);
  const [collapsed, setCollapsed] = useState(false);

  const dupes = useMemo(() => findDuplicateContent(messages), [messages]);
  const recentRecords = useMemo(
    () => records.slice(-25).slice().reverse(),
    [records],
  );

  const onCopy = () => {
    const blob = JSON.stringify(
      {
        sessionKey,
        streamingText,
        streamingBlockIndex,
        messages,
        records,
      },
      null,
      2,
    );
    navigator.clipboard?.writeText(blob).catch(() => {
      /* clipboard API may be unavailable; silently no-op */
    });
  };

  const onClear = () => {
    clearDebugRecords(sessionKey);
  };

  return (
    <div
      data-debug-inspector
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        marginTop: 6,
        border: `1px dashed ${PANEL_BORDER}`,
        borderRadius: 6,
        background: PANEL_BG,
        fontFamily: FONT_MONO,
        fontSize: 11,
        color: TEXT_PRIMARY,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setCollapsed((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "5px 8px",
          background: "transparent",
          border: "none",
          color: TEXT_MUTED,
          fontFamily: FONT_MONO,
          fontSize: 11,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>{collapsed ? "▸" : "▾"}</span>
        <span style={{ color: TEXT_PRIMARY }}>
          DEBUG{label ? ` · ${label}` : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <span>{records.length} evt</span>
          {dupes.length > 0 && (
            <span style={{ color: TEXT_DANGER }}>
              {dupes.length} dup
            </span>
          )}
        </span>
      </button>
      {!collapsed && (
        <div style={{ padding: "0 8px 8px" }}>
          <StateLine
            streamingText={streamingText}
            streamingBlockIndex={streamingBlockIndex}
            messageCount={messages.length}
          />
          {dupes.length > 0 && <DuplicatesPanel groups={dupes} />}
          <RecorderPanel records={recentRecords} />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button onClick={onCopy} style={btnStyle()}>
              Copy JSON
            </button>
            <button onClick={onClear} style={btnStyle()}>
              Clear buffer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-panels ──────────────────────────────────────────────

function StateLine({
  streamingText,
  streamingBlockIndex,
  messageCount,
}: {
  streamingText: string;
  streamingBlockIndex: number | null;
  messageCount: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        padding: "4px 0",
        color: TEXT_MUTED,
      }}
    >
      <span data-debug-field="streamingTextLen">
        streamingText: <Code>{streamingText.length}</Code> chars
      </span>
      <span data-debug-field="streamingBlockIndex">
        block: <Code>{streamingBlockIndex ?? "null"}</Code>
      </span>
      <span data-debug-field="messageCount">
        messages: <Code>{messageCount}</Code>
      </span>
    </div>
  );
}

function DuplicatesPanel({
  groups,
}: {
  groups: ReadonlyArray<{
    content: string;
    ids: ReadonlyArray<string>;
    roles: ReadonlyArray<string>;
  }>;
}) {
  return (
    <div
      data-debug-panel="duplicates"
      style={{
        marginTop: 4,
        padding: "4px 6px",
        border: `1px solid ${TEXT_DANGER}`,
        borderRadius: 4,
        color: TEXT_DANGER,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        Duplicate content detected
      </div>
      {groups.map((g, i) => (
        <div key={i} style={{ marginTop: 2 }}>
          <div style={{ color: TEXT_PRIMARY, opacity: 0.85 }}>
            roles: {g.roles.join(", ")}
          </div>
          <div
            style={{
              color: TEXT_PRIMARY,
              opacity: 0.6,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={g.content}
          >
            “{truncate(g.content, 100)}”
          </div>
        </div>
      ))}
    </div>
  );
}

function RecorderPanel({ records }: { records: ReadonlyArray<DebugRecord> }) {
  if (records.length === 0) {
    return (
      <div style={{ marginTop: 6, color: TEXT_MUTED }}>
        No events recorded yet.
      </div>
    );
  }
  return (
    <div data-debug-panel="recorder" style={{ marginTop: 6 }}>
      <div style={{ color: TEXT_MUTED, marginBottom: 2 }}>
        Recent events (newest first)
      </div>
      <div
        style={{
          maxHeight: 180,
          overflowY: "auto",
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 4,
        }}
      >
        {records.map((r) => (
          <div
            key={r.seq}
            style={{
              padding: "2px 6px",
              borderBottom: `1px solid ${PANEL_BORDER}`,
              display: "flex",
              gap: 8,
            }}
          >
            <span style={{ color: TEXT_MUTED, minWidth: 32 }}>#{r.seq}</span>
            <span style={{ color: TEXT_MUTED, minWidth: 36 }}>{r.source}</span>
            <span>{summarizeRecord(r)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function summarizeRecord(r: DebugRecord): string {
  const parts: string[] = [];
  parts.push(r.type);
  if (r.sdkType) parts.push(r.sdkType);
  if (r.streamEventType) parts.push(r.streamEventType);
  if (typeof r.blockIndex === "number") parts.push(`idx=${r.blockIndex}`);
  if (typeof r.deltaTextLen === "number") parts.push(`+${r.deltaTextLen}c`);
  if (r.parentToolUseId) parts.push(`subagent`);
  if (r.note) parts.push(r.note);
  return parts.join(" · ");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: TEXT_PRIMARY, fontFamily: FONT_MONO }}>
      {children}
    </span>
  );
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontFamily: FONT_MONO,
    background: "transparent",
    color: TEXT_PRIMARY,
    border: `1px solid ${PANEL_BORDER}`,
    borderRadius: 4,
    cursor: "pointer",
  };
}

// ── Recorder subscription via useSyncExternalStore ──────────

function useDebugRecords(sessionKey: string): ReadonlyArray<DebugRecord> {
  // useSyncExternalStore needs a stable subscribe function. We close over
  // sessionKey; if it changes, React unsubscribes/resubscribes.
  const subscribe = useMemo(
    () => (cb: () => void) => subscribeDebugRecorder(sessionKey, cb),
    [sessionKey],
  );
  const getSnapshot = () => getDebugRecords(sessionKey);
  // Server snapshot — same as client, since the recorder is a singleton.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

DebugInspector.displayName = "DebugInspector";
