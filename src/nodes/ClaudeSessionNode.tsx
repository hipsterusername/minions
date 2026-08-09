import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import type { NodeRenderProps, ThinkingConfig } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import type {
  ServerMessage,
  SyncEvent,
} from "../use-socket.ts";
import { subscribeSocketTopic } from "../use-socket.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { ModelOption, PermissionMode } from "../components/SessionToolbar.tsx";
import { StreamingBubble, StreamingIndicator } from "../components/StreamingBubble.tsx";
import { chatRoleStyle } from "../chat-bubble-style.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { UserContextHeader } from "../components/UserContextHeader.tsx";
import { AddAsNodeButton } from "../components/AddAsNodeButton.tsx";
import {
  extractParentId,
  extractStreamDelta,
  isStreamEnd,
  isStreamingEvent,
} from "../streaming.ts";
import {
  type DisplayMessage,
  msgId,
  normalizedToDisplayMessages,
} from "../sdk-messages.ts";
import { recordWsMessageForDebug } from "../debug-record-bridge.ts";
import { debugFlagStore } from "../debug.ts";
import { DebugInspector } from "../components/DebugInspector.tsx";
import { sessionTopic } from "../../shared/ws-envelope.ts";

type ScheduledFrame =
  | { kind: "raf"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof setTimeout> };

function scheduleFrame(fn: () => void): ScheduledFrame {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return { kind: "raf", id: window.requestAnimationFrame(fn) };
  }
  return { kind: "timeout", id: setTimeout(fn, 16) };
}

function cancelFrame(frame: ScheduledFrame | null): void {
  if (!frame) return;
  if (frame.kind === "raf" && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame.id);
    return;
  }
  clearTimeout(frame.id);
}

export interface SubagentInfo {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  lastTool?: string | undefined;
  summary?: string | undefined;
  tokenCount?: number | undefined;
  toolUses?: number | undefined;
  durationMs?: number | undefined;
}

export interface ClaudeSessionData {
  sessionKey: string | null;
  status:
    | "disconnected"
    | "creating"
    | "running"
    | "idle"
    | "stopped"
    | "error";
  messages: DisplayMessage[];
  totalCost: number;
  turns: number;
  error: string | null;
  model: ModelOption;
  permissionMode: PermissionMode;
  /** Active harness driving this session (e.g. "claude", "echo", "codex"). */
  harness?: string;
  /** Adaptive-thinking config sent to the SDK on every query() call. */
  thinkingConfig: ThinkingConfig;
  /** Streaming text from partial messages */
  streamingText: string;
  /**
   * Anthropic content block index that {@link streamingText} belongs to,
   * or `null` when no block is currently streaming. Used to flush the
   * preview buffer when a new content block starts so deltas from
   * `[text, tool_use, text]` don't merge across blocks.
   */
  streamingBlockIndex?: number | null | undefined;
  /** Duration of last turn in ms */
  lastDurationMs: number | null;
  /** Active subagent tasks */
  subagents: SubagentInfo[];
  /** Prompt suggestions after turn completion */
  promptSuggestions: string[];
  /** Init data from SDK */
  initData: Record<string, unknown> | null;
}

/**
 * Event kinds that produce feed messages in ClaudeSessionNode.
 *
 * This whitelist is intentionally narrow: `thinking`, `api_retry`, and
 * `rate_limit` are handled by the status-banner layer (not the feed),
 * while `usage`, `text_delta`, `stream_end`, and `tool_result` carry no
 * displayable content. Checking the kind before calling
 * `normalizedToDisplayMessages` keeps the feed identical to the legacy
 * `normalizedToDisplayMessages` behaviour and avoids banner-vs-feed
 * double-display for rate-limit / retry events.
 */
const SESSION_FEED_KINDS = new Set([
  "init",
  "text",
  "tool_call",
  "tool_progress",
  "done",
  "permission_denial",
]);

function rebuildFromSyncEvents(
  events: SyncEvent[],
  serverStatus: string,
  serverCost: number,
  serverTurns: number,
  serverError: string | null,
  sessionKey: string,
  serverModel?: string | null,
  serverPermissionMode?: string | null,
  serverHarness?: string | undefined,
): ClaudeSessionData {
  const messages: DisplayMessage[] = [];
  for (const evt of events) {
    if (evt.type === "sdk_event" && evt.event) {
      const ev = evt.event;
      if (SESSION_FEED_KINDS.has(ev.kind)) {
        messages.push(...normalizedToDisplayMessages(ev));
      }
    }
  }
  return {
    sessionKey,
    status: serverStatus as ClaudeSessionData["status"],
    messages,
    streamingText: "",
    streamingBlockIndex: null,
    totalCost: serverCost,
    turns: serverTurns,
    error: serverError,
    model: (serverModel as ModelOption) ?? "sonnet",
    permissionMode: (serverPermissionMode as PermissionMode) ?? "bypassPermissions",
    ...(serverHarness ? { harness: serverHarness } : {}),
    thinkingConfig: DEFAULT_THINKING_CONFIG,
    lastDurationMs: null,
    subagents: [],
    promptSuggestions: [],
    initData: null,
  };
}

// ── Message display components ──────────────────────────

type MessageGroup =
  | { kind: "single"; msg: DisplayMessage }
  | { kind: "tool-group"; msgs: DisplayMessage[] };

function groupMessages(messages: DisplayMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let toolBatch: DisplayMessage[] = [];

  const flushTools = () => {
    if (toolBatch.length > 0) {
      groups.push({ kind: "tool-group", msgs: [...toolBatch] });
      toolBatch = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === "tool") {
      toolBatch.push(msg);
    } else {
      flushTools();
      groups.push({ kind: "single", msg });
    }
  }
  flushTools();
  return groups;
}

const TOOL_ICONS: Record<string, string> = {
  Read: "\u25B7",
  Write: "\u25B6",
  Edit: "\u270E",
  Bash: "$",
  Glob: "\u2731",
  Grep: "/",
  Agent: "\u2726",
  WebFetch: "\u2197",
  WebSearch: "\u2315",
};

/** Format tool input into a readable summary string */
function formatToolInput(toolName: string, input?: Record<string, unknown>): string | null {
  if (!input || Object.keys(input).length === 0) return null;
  switch (toolName) {
    case "Read": return (input["file_path"] as string) ?? null;
    case "Write": return (input["file_path"] as string) ?? null;
    case "Edit": return (input["file_path"] as string) ?? null;
    case "Bash": return (input["command"] as string) ?? null;
    case "Glob": return (input["pattern"] as string) ?? null;
    case "Grep": return (input["pattern"] as string) ?? null;
    case "Agent": return (input["description"] as string) ?? (input["prompt"] as string) ?? null;
    case "WebFetch": return (input["url"] as string) ?? null;
    case "WebSearch": return (input["query"] as string) ?? null;
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0) return v;
      }
      return null;
    }
  }
}

/** Format the full tool input as key-value pairs for the detail view */
function formatToolInputDetail(input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return "(no input)";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    lines.push(`${k}: ${val}`);
  }
  return lines.join("\n");
}

function ToolItem({ msg, accentColor }: { msg: DisplayMessage; accentColor: string }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const icon = TOOL_ICONS[msg.toolName ?? ""] ?? "\u2022";
  const summary = formatToolInput(msg.toolName ?? "", msg.toolInput);
  const hasInput = msg.toolInput && Object.keys(msg.toolInput).length > 0;

  return (
    <div>
      <div
        onClick={hasInput ? () => setDetailOpen(!detailOpen) : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
          lineHeight: 1.6,
          cursor: hasInput ? "pointer" : "default",
          borderRadius: 3,
          padding: "1px 4px",
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => { if (hasInput) e.currentTarget.style.background = `${accentColor}11`; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <span
          style={{
            color: accentColor,
            opacity: 0.5,
            fontSize: 10,
            flexShrink: 0,
            width: 12,
            textAlign: "center",
          }}
        >
          {icon}
        </span>
        <span style={{ fontWeight: 500, flexShrink: 0 }}>{msg.toolName ?? "tool"}</span>
        {summary && (
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: 0.5,
              flex: 1,
              minWidth: 0,
            }}
          >
            {summary}
          </span>
        )}
        {hasInput && (
          <span
            style={{
              fontSize: 8,
              opacity: 0.35,
              flexShrink: 0,
              transition: "transform 0.15s",
              transform: detailOpen ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            &#9654;
          </span>
        )}
      </div>
      {detailOpen && hasInput && (
        <pre
          style={{
            margin: "2px 0 4px 22px",
            padding: "6px 8px",
            background: `${accentColor}08`,
            border: `1px solid ${accentColor}18`,
            borderRadius: 4,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 200,
            overflow: "auto",
            lineHeight: 1.5,
          }}
        >
          {formatToolInputDetail(msg.toolInput)}
        </pre>
      )}
    </div>
  );
}

function ToolGroup({ msgs }: { msgs: DisplayMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const toolNames = msgs.map((m) => m.toolName ?? "tool");
  const uniqueTools = [...new Set(toolNames)];
  const summary =
    uniqueTools.length <= 3
      ? uniqueTools.join(", ")
      : `${uniqueTools.slice(0, 2).join(", ")} +${uniqueTools.length - 2}`;

  return (
    <div style={{ marginBlock: 2 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 8px",
          background: "transparent",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          textAlign: "left",
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.color = "var(--text-dim)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.color = "var(--text-muted)")
        }
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            fontSize: 8,
            borderRadius: 3,
            background: "var(--success-bg)",
            color: "var(--success-color)",
            flexShrink: 0,
            transition: "transform 0.2s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          &#9654;
        </span>
        <span style={{ opacity: 0.7 }}>{summary}</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            opacity: 0.4,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {msgs.length}
        </span>
      </button>

      <div
        style={{
          display: "grid",
          gridTemplateRows: expanded ? "1fr" : "0fr",
          transition: "grid-template-rows 0.2s ease-out",
        }}
      >
        <div style={{ overflow: "hidden" }}>
          <div
            style={{
              paddingBlock: 2,
              paddingLeft: 24,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {msgs.map((m) => (
              <ToolItem key={m.id} msg={m} accentColor="var(--success-color)" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({ msg, onAddContentNode }: { msg: DisplayMessage; onAddContentNode?: ((content: string) => void) | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const COLLAPSED_HEIGHT = 200;

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollHeight > COLLAPSED_HEIGHT + 20);
  }, [msg.content]);

  const hasToolBlock = msg.content.includes("[Tool:");

  // Split content into prose and tool blocks for rendering
  const segments = hasToolBlock
    ? msg.content.split(/(\[Tool: [^\]]+\]\n[^[]*)/g).filter(Boolean)
    : [msg.content];

  return (
    <div style={{ position: "relative", marginBlock: 2 }} className="copyable">
      <CopyButton text={msg.content} />
      <AddAsNodeButton text={msg.content} onAdd={onAddContentNode} />
      <div
        ref={contentRef}
        style={{
          ...chatRoleStyle("assistant"),
          maxHeight:
            expanded || !isOverflowing ? "none" : COLLAPSED_HEIGHT,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {segments.map((seg, i) => {
          if (seg.startsWith("[Tool:")) {
            const firstNewline = seg.indexOf("\n");
            const toolHeader =
              firstNewline >= 0 ? seg.slice(0, firstNewline) : seg;
            const toolBody =
              firstNewline >= 0 ? seg.slice(firstNewline + 1) : "";
            return (
              <div
                key={i}
                style={{
                  marginBlock: 6,
                  borderRadius: 4,
                  overflow: "hidden",
                  border: "1px solid var(--border-default)",
                }}
              >
                <div
                  style={{
                    padding: "4px 8px",
                    background: "var(--success-bg)",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--success-color)",
                    opacity: 0.7,
                  }}
                >
                  {toolHeader}
                </div>
                {toolBody.trim() && (
                  <pre
                    style={{
                      margin: 0,
                      padding: "6px 8px",
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-dim)",
                      background: "var(--bg-primary)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      lineHeight: 1.5,
                      maxHeight: 120,
                      overflow: "auto",
                    }}
                  >
                    {toolBody.trim()}
                  </pre>
                )}
              </div>
            );
          }
          return <span key={i}>{seg}</span>;
        })}
      </div>

      {isOverflowing && !expanded && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 48,
            background:
              "linear-gradient(transparent, var(--bg-surface) 90%)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            paddingBottom: 4,
            borderRadius: "0 0 6px 6px",
          }}
        >
          <button
            onClick={() => setExpanded(true)}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              padding: "3px 12px",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            Show more
          </button>
        </div>
      )}

      {isOverflowing && expanded && (
        <button
          onClick={() => setExpanded(false)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            marginTop: 4,
            padding: "3px 12px",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            color: "var(--text-secondary)",
            cursor: "pointer",
            display: "block",
            marginInline: "auto",
          }}
        >
          Show less
        </button>
      )}
    </div>
  );
}

function UserBubble({ msg }: { msg: DisplayMessage }) {
  return (
    <div style={{ ...chatRoleStyle("user"), marginBlock: 2 }}>
      <UserContextHeader />
      {msg.content}
    </div>
  );
}

function SystemBubble({ msg }: { msg: DisplayMessage }) {
  return (
    <div style={{ ...chatRoleStyle("system"), marginBlock: 2 }}>
      {msg.content}
    </div>
  );
}

function ResultBubble({ msg, onAddContentNode }: { msg: DisplayMessage; onAddContentNode?: ((content: string) => void) | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = msg.content.length > 300;
  const meta = msg.meta;

  return (
    <div style={{ marginBlock: 4 }} className="copyable">
      <div
        style={{
          ...chatRoleStyle("result", { isError: !!meta?.isError }),
          maxHeight: expanded || !isLong ? "none" : 120,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <CopyButton text={msg.content} />
        <AddAsNodeButton text={msg.content} onAdd={onAddContentNode} />
        {msg.content}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            marginTop: 4,
            padding: "3px 12px",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            color: "var(--text-secondary)",
            cursor: "pointer",
            display: "block",
            marginInline: "auto",
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function MessageFeed({ messages, onAddContentNode }: { messages: DisplayMessage[]; onAddContentNode?: ((content: string) => void) | undefined }) {
  const groups = groupMessages(messages);
  return (
    <>
      {groups.map((group, i) => {
        if (group.kind === "tool-group") {
          return <ToolGroup key={group.msgs[0]?.id ?? i} msgs={group.msgs} />;
        }
        const msg = group.msg;
        switch (msg.role) {
          case "user":
            return <UserBubble key={msg.id} msg={msg} />;
          case "assistant":
            return <AssistantBubble key={msg.id} msg={msg} onAddContentNode={onAddContentNode} />;
          case "system":
            return <SystemBubble key={msg.id} msg={msg} />;
          case "result":
            return <ResultBubble key={msg.id} msg={msg} onAddContentNode={onAddContentNode} />;
          default:
            return null;
        }
      })}
    </>
  );
}

// ── Main renderer ───────────────────────────────────────

export function ClaudeSessionRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  onAddContentNode,
  projectPath,
}: NodeRenderProps) {
  const data = node.data as ClaudeSessionData;
  const dataRef = useRef(data);
  const pendingStreamingFrameRef = useRef<ScheduledFrame | null>(null);
  const pendingStreamingDataRef = useRef<ClaudeSessionData | null>(null);
  const onUpdateDataRef = useRef(onUpdateData);
  onUpdateDataRef.current = onUpdateData;
  if (!pendingStreamingDataRef.current) {
    dataRef.current = data;
  } else if (data !== dataRef.current) {
    const pending = pendingStreamingDataRef.current;
    if (data.sessionKey === pending.sessionKey) {
      const rebased = {
        ...data,
        streamingText: pending.streamingText,
        streamingBlockIndex: pending.streamingBlockIndex,
      };
      pendingStreamingDataRef.current = rebased;
      dataRef.current = rebased;
    } else {
      pendingStreamingDataRef.current = null;
      dataRef.current = data;
    }
  }

  const [input, setInput] = useState("");
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const syncedRef = useRef(false);
  const { banners, processNormalizedEvent, dismissBanner } = useStatusBanners();
  const debugEnabled = useSyncExternalStore(
    debugFlagStore.subscribe,
    debugFlagStore.getSnapshot,
    debugFlagStore.getSnapshot,
  );
  const flushStreamingRef = useRef<() => void>(() => undefined);
  flushStreamingRef.current = () => {
    const pending = pendingStreamingDataRef.current;
    pendingStreamingFrameRef.current = null;
    pendingStreamingDataRef.current = null;
    if (pending) {
      onUpdateDataRef.current(pending);
    }
  };
  const emitStreamingUpdate = useCallback((next: ClaudeSessionData) => {
    dataRef.current = next;
    pendingStreamingDataRef.current = next;
    if (!pendingStreamingFrameRef.current) {
      pendingStreamingFrameRef.current = scheduleFrame(() => {
        flushStreamingRef.current();
      });
    }
  }, []);
  const emitDurableUpdate = useCallback((next: ClaudeSessionData) => {
    cancelFrame(pendingStreamingFrameRef.current);
    pendingStreamingFrameRef.current = null;
    pendingStreamingDataRef.current = null;
    dataRef.current = next;
    onUpdateData(next);
  }, [onUpdateData]);

  useEffect(() => {
    return () => {
      cancelFrame(pendingStreamingFrameRef.current);
      pendingStreamingFrameRef.current = null;
      pendingStreamingDataRef.current = null;
    };
  }, []);

  // Scroll handler: detect if user scrolled up
  const handleMessagesScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    userScrolledUpRef.current = !isNearBottom;
    setShowJumpToBottom(!isNearBottom && data.status === "running");
  }, [data.status]);

  // Auto-scroll to bottom (triggers on new messages and streaming text changes)
  useEffect(() => {
    if (!userScrolledUpRef.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
    // Show jump-to-bottom if user is scrolled up and new content arrived
    if (userScrolledUpRef.current && (data.messages.length > 0 || data.streamingText)) {
      setShowJumpToBottom(true);
    }
  }, [data.messages.length, data.streamingText]);

  // Request sync on mount if we have a sessionKey
  useEffect(() => {
    if (!socketSend || !data.sessionKey || syncedRef.current) return;
    syncedRef.current = true;
    socketSend({ type: "sync_session", sessionKey: data.sessionKey });
  }, [socketSend, data.sessionKey]);

  // Subscribe to WebSocket events for this session
  useEffect(() => {
    if (!socketSubscribe || !data.sessionKey) return;

    const unsubscribe = subscribeSocketTopic(socketSubscribe, sessionTopic(data.sessionKey), (msg: unknown) => {
      const serverMsg = msg as ServerMessage;
      const current = dataRef.current;
      // Debug capture for the ad-hoc subscription. ClaudeSessionNode
      // does NOT use `useSessionStream`, so we instrument here so the
      // DebugInspector still sees every event for this session.
      recordWsMessageForDebug(current.sessionKey, serverMsg, "claude");

      if (
        serverMsg.type === "sync_response" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        if (serverMsg.found && serverMsg.events) {
          const rebuilt = rebuildFromSyncEvents(
            serverMsg.events,
            serverMsg.status ?? current.status,
            serverMsg.totalCost ?? current.totalCost,
            serverMsg.turns ?? current.turns,
            serverMsg.lastError ?? null,
            current.sessionKey!,
            serverMsg.model,
            serverMsg.permissionMode,
            serverMsg.harness,
          );
          emitDurableUpdate(rebuilt);
        } else if (!serverMsg.found) {
          emitDurableUpdate({
            ...current,
            status: "disconnected" as const,
          });
        }
        return;
      }

      if (!current.sessionKey) return;

      if (
        serverMsg.type === "sdk_event" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        const ev = serverMsg.event;
        processNormalizedEvent(ev);

        // Handle streaming text deltas (single emit, early return).
        if (isStreamingEvent(ev)) {
          // Drop stream events from sub-agents (Agent/Task tool) — their
          // deltas would otherwise interleave with the parent session's
          // streaming preview because they share the same sessionKey.
          if (extractParentId(ev) !== null) {
            return;
          }
          const delta = extractStreamDelta(ev);
          if (delta !== null) {
            const activeIndex = current.streamingBlockIndex ?? null;
            // Block boundary: a delta arrived for a different content
            // block. Reset the buffer so text from `[text, tool_use,
            // text]` doesn't merge across blocks in the live preview.
            if (activeIndex !== delta.index) {
              emitStreamingUpdate({
                ...current,
                streamingText: delta.text,
                streamingBlockIndex: delta.index,
              });
            } else {
              emitStreamingUpdate({
                ...current,
                streamingText: (current.streamingText ?? "") + delta.text,
              });
            }
          } else if (
            isStreamEnd(ev) &&
            (current.streamingText || current.streamingBlockIndex != null)
          ) {
            // Stream ended — clear streaming text so stale content doesn't
            // linger while the complete assistant message is in flight.
            emitDurableUpdate({ ...current, streamingText: "", streamingBlockIndex: null });
          }
          return;
        }

        // ── Single-emit accumulator ─────────────────────────
        let updated: ClaudeSessionData = current;
        let changed = false;

        // Handle usage and done events (no feed message, but update cost/turns/status).
        if (ev.kind === "usage" && ev.costUSD != null) {
          updated = { ...updated, totalCost: ev.costUSD };
          changed = true;
        }
        if (ev.kind === "done") {
          updated = {
            ...updated,
            status: "idle" as const,
            streamingText: "",
            streamingBlockIndex: null,
            promptSuggestions: [],
          };
          if (ev.turns != null) updated = { ...updated, turns: ev.turns };
          changed = true;
        }

        const newMsgs = SESSION_FEED_KINDS.has(ev.kind) ? normalizedToDisplayMessages(ev) : [];
        if (newMsgs.length > 0) {
          let base = updated.messages;
          // When a done event arrives with a result, drop the last assistant
          // msg if its content matches — the SDK sends both, but we only
          // want the green result bubble. Normalize by stripping task-name tags.
          if (ev.kind === "done") {
            const resultText = newMsgs.find((m) => m.role === "result")?.content;
            if (resultText) {
              const normalizedResult = resultText.replace(/<!--task-name:.+?-->\s*/g, "").trim();
              const lastIdx = base.findLastIndex((m) => m.role === "assistant");
              if (lastIdx >= 0 &&
                  (base[lastIdx]?.content ?? "").replace(/<!--task-name:.+?-->\s*/g, "").trim() === normalizedResult) {
                base = [...base.slice(0, lastIdx), ...base.slice(lastIdx + 1)];
              }
            }
          }
          updated = { ...updated, messages: [...base, ...newMsgs] };
          // When a complete assistant text arrives, clear streaming buffer
          if (ev.kind === "text" && ev.role === "assistant") {
            updated.streamingText = "";
            updated.streamingBlockIndex = null;
          }
          changed = true;
        }

        if (changed) {
          emitDurableUpdate(updated);
        }
        return;
      }

      if (
        serverMsg.type === "session_status" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitDurableUpdate({
          ...current,
          status: serverMsg.status as ClaudeSessionData["status"],
        });
        return;
      }

      if (
        serverMsg.type === "session_error" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitDurableUpdate({
          ...current,
          status: "error" as const,
          error: serverMsg.error,
        });
        return;
      }

      if (
        serverMsg.type === "session_cleared" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitDurableUpdate({
          ...current,
          messages: [],
          streamingText: "",
          streamingBlockIndex: null,
          totalCost: 0,
          turns: 0,
          subagents: [],
          promptSuggestions: [],
        });
      }
    });
    return () => {
      unsubscribe?.();
      cancelFrame(pendingStreamingFrameRef.current);
      pendingStreamingFrameRef.current = null;
      pendingStreamingDataRef.current = null;
    };
  }, [
    socketSubscribe,
    data.sessionKey,
    emitDurableUpdate,
    emitStreamingUpdate,
    processNormalizedEvent,
  ]);

  const handleCreate = useCallback(() => {
    if (!socketSend) return;
    const current = dataRef.current;
    const key = `sk-${Date.now().toString(36)}`;
    const prompt =
      input.trim() || "Hello! What would you like to work on?";
    socketSend({
      type: "create_session",
      sessionKey: key,
      prompt,
      model: current.model,
      thinkingConfig: current.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      ...(current.harness ? { harness: current.harness } : {}),
      ...(projectPath ? { cwd: projectPath } : {}),
    });
    syncedRef.current = true;
    onUpdateData({
      ...dataRef.current,
      sessionKey: key,
      status: "creating",
      messages: [
        {
          id: msgId(),
          role: "user" as const,
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    });
    setInput("");
  }, [socketSend, input, onUpdateData]);

  const handleSend = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !input.trim() || !current.sessionKey) return;
    socketSend({
      type: "send_message",
      sessionKey: current.sessionKey,
      prompt: input.trim(),
      thinkingConfig: current.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
    });
    onUpdateData({
      ...current,
      status: "running",
      messages: [
        ...current.messages,
        {
          id: msgId(),
          role: "user" as const,
          content: input.trim(),
          timestamp: Date.now(),
        },
      ],
    });
    setInput("");
  }, [socketSend, input, onUpdateData]);

  const handleStop = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !current.sessionKey) return;
    socketSend({ type: "stop_session", sessionKey: current.sessionKey });
  }, [socketSend]);

  const handleInterrupt = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !current.sessionKey) return;
    socketSend({ type: "interrupt", sessionKey: current.sessionKey });
  }, [socketSend]);

  const handleClear = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !current.sessionKey) return;
    socketSend({ type: "clear_session", sessionKey: current.sessionKey });
  }, [socketSend]);

  const handleModelChange = useCallback(
    (model: string) => {
      const current = dataRef.current;
      onUpdateData({ ...current, model: model as ModelOption });
      if (socketSend && current.sessionKey) {
        socketSend({
          type: "set_model",
          sessionKey: current.sessionKey,
          model,
        });
      }
    },
    [socketSend, onUpdateData],
  );

  const handleHarnessChange = useCallback(
    (harness: string, defaultModel?: string) => {
      const current = dataRef.current;
      // Mid-session swap is intentionally unsupported — the toolbar
      // disables this control once `sessionKey` is set.
      if (current.sessionKey) return;
      // Apply harness + model atomically. Two separate onUpdateData calls
      // would both read the stale `dataRef.current` and the second would
      // clobber the harness update.
      onUpdateData({
        ...current,
        harness,
        ...(defaultModel ? { model: defaultModel as ModelOption } : {}),
      });
    },
    [onUpdateData],
  );

  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      const current = dataRef.current;
      onUpdateData({ ...current, permissionMode: mode });
      if (socketSend && current.sessionKey) {
        socketSend({
          type: "set_permission_mode",
          sessionKey: current.sessionKey,
          permissionMode: mode,
        });
      }
    },
    [socketSend, onUpdateData],
  );

  const handleThinkingConfigChange = useCallback(
    (cfg: ThinkingConfig) => {
      const current = dataRef.current;
      onUpdateData({ ...current, thinkingConfig: cfg });
    },
    [onUpdateData],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (dataRef.current.sessionKey) {
          handleSend();
        } else {
          handleCreate();
        }
      }
      if (e.key === "Escape" && dataRef.current.status === "running") {
        e.preventDefault();
        handleStop();
      }
      if (e.key === "." && (e.ctrlKey || e.metaKey) && dataRef.current.status === "running") {
        e.preventDefault();
        handleStop();
      }
    },
    [handleSend, handleCreate, handleStop],
  );

  const statusColor: Record<string, string> = {
    disconnected: "var(--text-muted)",
    creating: "var(--status-creating)",
    running: "var(--success-color)",
    idle: "var(--streaming-color)",
    stopped: "var(--status-error)",
    error: "var(--danger-color)",
  };

  const statusLabel: Record<string, string> = {
    disconnected: "Disconnected",
    creating: "Starting...",
    running: "Running",
    idle: "Idle",
    stopped: "Stopped",
    error: "Error",
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderRadius: 8,
        border: "1px solid var(--border-default)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
          background: "var(--bg-secondary)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor[data.status] ?? "var(--text-muted)",
              boxShadow:
                data.status === "running"
                  ? `0 0 8px ${statusColor["running"]}`
                  : "none",
              transition: "all 0.3s",
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              letterSpacing: 0.5,
            }}
          >
            {statusLabel[data.status] ?? data.status}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {data.totalCost > 0 && (
            <span
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ${data.totalCost.toFixed(4)}
            </span>
          )}
          {data.turns > 0 && (
            <span
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {data.turns}T
            </span>
          )}
          {data.sessionKey &&
            data.status !== "running" &&
            data.status !== "creating" &&
            data.messages.length > 0 && (
              <button
                onClick={handleClear}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  padding: "2px 8px",
                  fontSize: 10,
                  background: "transparent",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                Clear
              </button>
            )}
          {data.status === "running" && (
            <button
              onClick={handleStop}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                padding: "2px 8px",
                fontSize: 10,
                background: "var(--danger-bg)",
                border: "1px solid var(--danger-color)",
                borderRadius: 4,
                color: "var(--status-error)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              Stop
            </button>
          )}
        </div>
      </div>

      <StatusBannerStack banners={banners} onDismiss={dismissBanner} />

      <SessionToolbar
        sessionKey={data.sessionKey}
        status={data.status}
        model={data.model ?? "sonnet"}
        permissionMode={data.permissionMode ?? "bypassPermissions"}
        onInterrupt={handleInterrupt}
        onModelChange={handleModelChange}
        onPermissionModeChange={handlePermissionModeChange}
        thinkingConfig={data.thinkingConfig ?? DEFAULT_THINKING_CONFIG}
        onThinkingConfigChange={handleThinkingConfigChange}
        harness={data.harness ?? "claude"}
        onHarnessChange={handleHarnessChange}
      />

      <div
        ref={outputRef}
        onScroll={handleMessagesScroll}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          position: "relative",
        }}
      >
        {data.messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            {data.sessionKey
              ? "Waiting for response..."
              : "Enter a prompt to start a session"}
          </div>
        )}
        <MessageFeed messages={data.messages} onAddContentNode={onAddContentNode} />
        {data.streamingText ? (
          <StreamingBubble text={data.streamingText} role="assistant" />
        ) : data.status === "running" && data.messages.length > 0 ? (
          <StreamingIndicator />
        ) : null}
        {debugEnabled && data.sessionKey && (
          <DebugInspector
            sessionKey={data.sessionKey}
            streamingText={data.streamingText}
            streamingBlockIndex={data.streamingBlockIndex ?? null}
            messages={data.messages}
            label="claude-session"
          />
        )}
        {showJumpToBottom && (
          <div
            style={{
              position: "sticky",
              bottom: 8,
              left: "50%",
              transform: "translateX(-50%)",
              background: "var(--accent)",
              color: "var(--text-primary)",
              padding: "4px 12px",
              borderRadius: 12,
              fontSize: 11,
              cursor: "pointer",
              zIndex: 10,
              fontFamily: "var(--font-sans)",
              boxShadow: "var(--shadow-md)",
              alignSelf: "center",
              flexShrink: 0,
            }}
            onClick={() => {
              if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
              userScrolledUpRef.current = false;
              setShowJumpToBottom(false);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            ↓ New messages
          </div>
        )}
      </div>

      {data.subagents && data.subagents.filter(s => s.status === "running").length > 0 && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--border-default)",
            background: "var(--state-hover)",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--tool-accent)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
            Subagents ({data.subagents.filter(s => s.status === "running").length} running)
          </div>
          {data.subagents.filter(s => s.status === "running").map(sa => (
            <div key={sa.taskId} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--tool-accent)", boxShadow: "0 0 6px var(--tool-accent)", flexShrink: 0, animation: "pulse 1.5s infinite" }} />
              <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {sa.description || sa.taskId}
              </span>
              {sa.lastTool && (
                <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {sa.lastTool}
                </span>
              )}
              {sa.tokenCount != null && (
                <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {(sa.tokenCount / 1000).toFixed(0)}k
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {data.promptSuggestions && data.promptSuggestions.length > 0 && data.status === "idle" && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--border-default)",
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          {data.promptSuggestions.map((suggestion, i) => (
            <button
              key={i}
              onClick={() => {
                setInput(suggestion);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                padding: "4px 10px",
                fontSize: 10,
                fontFamily: "var(--font-sans)",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                borderRadius: 12,
                color: "var(--text-secondary)",
                cursor: "pointer",
                transition: "all 0.15s",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--accent)";
                e.currentTarget.style.color = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border-default)";
                e.currentTarget.style.color = "var(--text-secondary)";
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <div
        style={{
          padding: "8px 10px",
          borderTop: "1px solid var(--border-default)",
          display: "flex",
          gap: 6,
          flexShrink: 0,
          background: "var(--bg-secondary)",
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          placeholder={
            data.sessionKey
              ? "Send a message..."
              : "Enter prompt to start session..."
          }
          rows={1}
          style={{
            flex: 1,
            padding: "8px 10px",
            background: "var(--bg-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            color: "var(--text-primary)",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            resize: "none",
            outline: "none",
            lineHeight: 1.4,
          }}
        />
        <button
          onClick={data.sessionKey ? handleSend : handleCreate}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={!input.trim() && !!data.sessionKey}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background:
              input.trim() || !data.sessionKey
                ? "var(--accent)"
                : "var(--bg-elevated)",
            color:
              input.trim() || !data.sessionKey
                ? "var(--text-primary)"
                : "var(--text-muted)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
            transition: "opacity 0.15s",
            opacity: !input.trim() && !!data.sessionKey ? 0.4 : 1,
          }}
        >
          {data.sessionKey ? "Send" : "Start"}
        </button>
      </div>
      {data.status === "running" && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center",
          padding: "2px 0", fontFamily: "var(--font-sans)" }}>
          Press Esc to interrupt
        </div>
      )}

      {data.error && (
        <div
          style={{
            padding: "6px 10px",
            background: "var(--danger-bg)",
            color: "var(--status-error)",
            fontSize: 11,
            borderTop: "1px solid var(--danger-color)",
            fontFamily: "var(--font-mono)",
            wordBreak: "break-word",
          }}
        >
          {data.error}
        </div>
      )}
    </div>
  );
}

registerNodeType({
  type: "claude-session",
  label: "Claude Session",
  defaultSize: { width: 480, height: 400 },
  render: ClaudeSessionRenderer,
  userCreatable: false,
  agentType: "default",
});
