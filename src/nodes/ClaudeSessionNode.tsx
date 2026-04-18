import { useState, useEffect, useRef, useCallback } from "react";
import type { NodeRenderProps, ThinkingConfig } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import type {
  ServerMessage,
  SdkMessage,
  ContentBlock,
  SyncEvent,
  ModelUsage,
} from "../use-socket.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { ModelOption, PermissionMode } from "../components/SessionToolbar.tsx";
import { StreamingBubble, StreamingIndicator } from "../components/StreamingBubble.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { AddAsNodeButton } from "../components/AddAsNodeButton.tsx";
import { extractStreamDelta, isStreamingEvent, isStreamEnd } from "../streaming.ts";

export interface SubagentInfo {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  lastTool?: string;
  summary?: string;
  tokenCount?: number;
  toolUses?: number;
  durationMs?: number;
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
  messages: SessionMessage[];
  totalCost: number;
  turns: number;
  error: string | null;
  model: ModelOption;
  permissionMode: PermissionMode;
  /** Adaptive-thinking config sent to the SDK on every query() call. */
  thinkingConfig: ThinkingConfig;
  /** Streaming text from partial messages */
  streamingText: string;
  /** Per-model cost breakdown from last result */
  modelUsage: Record<string, ModelUsage> | null;
  /** Duration of last turn in ms */
  lastDurationMs: number | null;
  /** Active subagent tasks */
  subagents: SubagentInfo[];
  /** Prompt suggestions after turn completion */
  promptSuggestions: string[];
  /** Init data from SDK */
  initData: Record<string, unknown> | null;
}

type SessionMessageRole = "user" | "assistant" | "tool" | "system" | "result";

interface SessionMessage {
  id: string;
  role: SessionMessageRole;
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** For result messages: structured metadata */
  meta?: ResultMeta;
}

interface ResultMeta {
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  turns?: number;
  stopReason?: string | null;
  modelUsage?: Record<string, ModelUsage>;
  isError?: boolean;
  errors?: string[];
}

function msgId(): string {
  return `m-${crypto.randomUUID()}`;
}

function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      const inputStr = block.input
        ? JSON.stringify(block.input, null, 2)
        : "";
      const preview =
        inputStr.length > 200 ? inputStr.slice(0, 200) + "..." : inputStr;
      parts.push(`[Tool: ${block.name}]\n${preview}`);
    } else if (block.type === "tool_result" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function sdkMessageToSessionMessages(
  sdkMsg: SdkMessage,
): SessionMessage[] {
  const out: SessionMessage[] = [];
  const now = Date.now();
  switch (sdkMsg.type) {
    case "system": {
      const sub = sdkMsg.subtype;
      if (sub === "init") {
        const model = sdkMsg.model ?? "unknown";
        const tc = sdkMsg.tools?.length ?? 0;
        const mc = sdkMsg.mcp_servers?.length ?? 0;
        const p = [`Session on ${model}`];
        if (tc > 0) p.push(`${tc} tools`);
        if (mc > 0) p.push(`${mc} MCP`);
        out.push({ id: msgId(), role: "system", content: p.join(" \u00B7 "), timestamp: now });
      } else if (sub === "local_command_output" && sdkMsg.content) {
        out.push({ id: msgId(), role: "system", content: sdkMsg.content, timestamp: now });
      } else if (sub === "task_started") {
        out.push({ id: msgId(), role: "system", content: `Subagent: ${sdkMsg.description ?? sdkMsg.task_id ?? "task"}`, timestamp: now });
      } else if (sub === "task_notification") {
        const ico = sdkMsg.status === "completed" ? "\u2713" : sdkMsg.status === "failed" ? "\u2717" : "\u25A0";
        out.push({ id: msgId(), role: "system", content: `${ico} Subagent ${sdkMsg.status}: ${sdkMsg.summary ?? sdkMsg.task_id ?? ""}`, timestamp: now });
      } else if (sub === "hook_started") {
        out.push({ id: msgId(), role: "system", content: `Hook: ${sdkMsg.hook_name ?? sdkMsg.hook_event ?? "running"}...`, timestamp: now });
      } else if (sub === "hook_response" && sdkMsg.outcome === "error") {
        out.push({ id: msgId(), role: "system", content: `Hook failed: ${sdkMsg.hook_name ?? ""} (exit ${sdkMsg.exit_code ?? "?"})`, timestamp: now });
      } else if (sub === "files_persisted" && sdkMsg.files && sdkMsg.files.length > 0) {
        out.push({ id: msgId(), role: "system", content: `Files saved: ${sdkMsg.files.map(f => f.filename).join(", ")}`, timestamp: now });
      } else if (sub === "elicitation_complete") {
        out.push({ id: msgId(), role: "system", content: `MCP input done (${sdkMsg.mcp_server_name ?? "server"})`, timestamp: now });
      }
      // api_retry, compact_boundary, status, session_state_changed, hook_progress, task_progress
      // handled by StatusBanner or subagent state updates
      break;
    }
    case "assistant":
      if (sdkMsg.message?.content) {
        const blocks = sdkMsg.message.content;
        // Split content blocks into separate messages for proper grouping
        const textParts: string[] = [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_use" && block.name) {
            // Flush accumulated text first
            if (textParts.length > 0) {
              const joined = textParts.join("\n").trim();
              if (joined) out.push({ id: msgId(), role: "assistant", content: joined, timestamp: now });
              textParts.length = 0;
            }
            out.push({
              id: msgId(), role: "tool",
              content: block.name,
              timestamp: now,
              toolName: block.name,
              toolInput: block.input as Record<string, unknown> | undefined,
            });
          } else if (block.type === "tool_result" && block.text) {
            textParts.push(block.text);
          }
        }
        if (textParts.length > 0) {
          const joined = textParts.join("\n").trim();
          if (joined) out.push({ id: msgId(), role: "assistant", content: joined, timestamp: now });
        }
      }
      break;
    case "stream_event":
      break; // handled separately for live streaming text
    case "tool_progress":
      out.push({
        id: msgId(), role: "tool",
        content: `${sdkMsg.tool_name} (${sdkMsg.elapsed_time_seconds?.toFixed(1)}s)`,
        timestamp: now, toolName: sdkMsg.tool_name,
      });
      break;
    case "tool_use_summary":
      if (sdkMsg.summary) {
        out.push({ id: msgId(), role: "system", content: sdkMsg.summary, timestamp: now });
      }
      break;
    case "result": {
      const isErr = sdkMsg.is_error;
      const txt = sdkMsg.result ?? (isErr ? (sdkMsg.errors?.join("; ") ?? "Error") : "Done");
      out.push({
        id: msgId(), role: "result",
        content: txt,
        timestamp: now,
        meta: {
          durationMs: sdkMsg.duration_ms ?? undefined,
          durationApiMs: sdkMsg.duration_api_ms ?? undefined,
          costUsd: sdkMsg.total_cost_usd ?? undefined,
          turns: sdkMsg.num_turns ?? undefined,
          stopReason: sdkMsg.stop_reason,
          modelUsage: sdkMsg.modelUsage ?? undefined,
          isError: isErr ?? undefined,
          errors: sdkMsg.errors ?? undefined,
        },
      });
      break;
    }
    case "auth_status":
      if (sdkMsg.error) {
        out.push({ id: msgId(), role: "system", content: `Auth: ${sdkMsg.error}`, timestamp: now });
      }
      break;
    // prompt_suggestion, rate_limit_event handled via data state / StatusBanner
  }
  return out;
}

function rebuildFromSyncEvents(
  events: SyncEvent[],
  serverStatus: string,
  serverCost: number,
  serverTurns: number,
  serverError: string | null,
  sessionKey: string,
  serverModel?: string | null,
  serverPermissionMode?: string | null,
): ClaudeSessionData {
  const messages: SessionMessage[] = [];
  for (const evt of events) {
    if (evt.type === "sdk_event" && evt.message) {
      const msgs = sdkMessageToSessionMessages(evt.message);
      messages.push(...msgs);
    }
  }
  return {
    sessionKey,
    status: serverStatus as ClaudeSessionData["status"],
    messages,
    streamingText: "",
    totalCost: serverCost,
    turns: serverTurns,
    error: serverError,
    model: (serverModel as ModelOption) ?? "sonnet",
    permissionMode: (serverPermissionMode as PermissionMode) ?? "bypassPermissions",
    modelUsage: null,
    lastDurationMs: null,
    subagents: [],
    promptSuggestions: [],
    initData: null,
  };
}

// ── Message display components ──────────────────────────

type MessageGroup =
  | { kind: "single"; msg: SessionMessage }
  | { kind: "tool-group"; msgs: SessionMessage[] };

function groupMessages(messages: SessionMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let toolBatch: SessionMessage[] = [];

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
    case "Read": return input.file_path as string ?? null;
    case "Write": return input.file_path as string ?? null;
    case "Edit": return input.file_path as string ?? null;
    case "Bash": return input.command as string ?? null;
    case "Glob": return input.pattern as string ?? null;
    case "Grep": return input.pattern as string ?? null;
    case "Agent": return input.description as string ?? input.prompt as string ?? null;
    case "WebFetch": return input.url as string ?? null;
    case "WebSearch": return input.query as string ?? null;
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

function ToolItem({ msg, accentColor }: { msg: SessionMessage; accentColor: string }) {
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

function ToolGroup({ msgs }: { msgs: SessionMessage[] }) {
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

function AssistantBubble({ msg, onAddContentNode }: { msg: SessionMessage; onAddContentNode?: (content: string) => void }) {
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
          padding: "8px 10px",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.6,
          fontFamily: "var(--font-sans)",
          color: "var(--text-primary)",
          borderLeft: "2px solid var(--streaming-color)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "break-word",
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

function UserBubble({ msg }: { msg: SessionMessage }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.6,
        fontFamily: "var(--font-sans)",
        color: "var(--accent)",
        borderLeft: "2px solid var(--accent)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "break-word",
        marginBlock: 2,
      }}
    >
      {msg.content}
    </div>
  );
}

function SystemBubble({ msg }: { msg: SessionMessage }) {
  return (
    <div
      style={{
        padding: "4px 10px",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
        textAlign: "center",
        opacity: 0.6,
        marginBlock: 2,
      }}
    >
      {msg.content}
    </div>
  );
}

function ModelUsageBar({ modelUsage }: { modelUsage: Record<string, ModelUsage> }) {
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return null;
  const totalCost = entries.reduce((s, [, u]) => s + u.costUSD, 0);
  const MODEL_COLORS: Record<string, string> = {
    opus: "var(--model-opus)", sonnet: "var(--model-sonnet)", haiku: "var(--model-haiku)",
  };

  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Model usage
      </div>
      {entries.map(([model, usage]) => {
        const pct = totalCost > 0 ? (usage.costUSD / totalCost) * 100 : 0;
        const shortName = model.replace(/claude-/, "").replace(/-\d.*$/, "");
        const color = MODEL_COLORS[shortName] ?? "var(--streaming-color)";
        return (
          <div key={model} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color, minWidth: 48, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
              {shortName}
            </span>
            <div style={{ flex: 1, height: 4, background: "var(--bg-elevated)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${Math.max(pct, 2)}%`, height: "100%", background: color, borderRadius: 2, opacity: 0.7, transition: "width 0.3s" }} />
            </div>
            <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-muted)", minWidth: 52, textAlign: "right" }}>
              ${usage.costUSD.toFixed(4)}
            </span>
            <span style={{ fontSize: 8, fontFamily: "var(--font-mono)", color: "var(--text-muted)", opacity: 0.6 }}>
              {((usage.inputTokens + usage.outputTokens) / 1000).toFixed(0)}k
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ResultBubble({ msg, onAddContentNode }: { msg: SessionMessage; onAddContentNode?: (content: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = msg.content.length > 300;
  const meta = msg.meta;
  const hasUsage = meta?.modelUsage && Object.keys(meta.modelUsage).length > 0;

  return (
    <div style={{ marginBlock: 4 }} className="copyable">
      <div
        style={{
          padding: "8px 10px",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.6,
          fontFamily: "var(--font-sans)",
          color: meta?.isError ? "var(--status-error)" : "var(--text-primary)",
          borderLeft: `2px solid ${meta?.isError ? "var(--danger-color)" : "var(--tool-accent)"}`,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "break-word",
          maxHeight: expanded || !isLong ? "none" : 120,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <CopyButton text={msg.content} />
        <AddAsNodeButton text={msg.content} onAdd={onAddContentNode} />
        {msg.content}
        {meta && (() => {
          const ds = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : null;
          const cs = meta.costUsd ? `$${meta.costUsd.toFixed(4)}` : null;
          const ts = meta.turns ? `${meta.turns}T` : null;
          const sfx = [ds, cs, ts].filter(Boolean).join(" · ");
          return sfx ? (
            <span style={{ display: "inline-block", marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", opacity: 0.7 }}>
              {sfx}
            </span>
          ) : null;
        })()}
        {expanded && hasUsage && meta?.modelUsage && (
          <ModelUsageBar modelUsage={meta.modelUsage} />
        )}
        {expanded && meta?.stopReason && meta.stopReason !== "end_turn" && (
          <div style={{ marginTop: 4, fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
            stop: {meta.stopReason}
          </div>
        )}
      </div>
      {(isLong || hasUsage) && (
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
          {expanded ? "Show less" : hasUsage ? "Show details" : "Show more"}
        </button>
      )}
    </div>
  );
}

function MessageFeed({ messages, onAddContentNode }: { messages: SessionMessage[]; onAddContentNode?: (content: string) => void }) {
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
  dataRef.current = data;

  const [input, setInput] = useState("");
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const syncedRef = useRef(false);
  const { banners, processSdkEvent, dismissBanner } = useStatusBanners();

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
    if (!socketSubscribe) return;

    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as ServerMessage;
      const current = dataRef.current;

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
          );
          onUpdateData(rebuilt);
        } else if (!serverMsg.found) {
          onUpdateData({
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
        processSdkEvent(serverMsg.message);

        // Handle streaming text deltas
        if (isStreamingEvent(serverMsg.message)) {
          const delta = extractStreamDelta(serverMsg.message);
          if (delta !== null) {
            onUpdateData({
              ...current,
              streamingText: (current.streamingText ?? "") + delta,
            });
          } else if (isStreamEnd(serverMsg.message) && current.streamingText) {
            // Stream ended — clear streaming text so stale content doesn't
            // linger while the complete assistant message is in flight.
            onUpdateData({ ...current, streamingText: "" });
          }
          return;
        }

        // Handle subagent task state updates
        const sdkM = serverMsg.message;
        if (sdkM.type === "system" && sdkM.subtype === "task_started" && sdkM.task_id) {
          const sa: SubagentInfo = { taskId: sdkM.task_id, description: sdkM.description ?? "", status: "running" };
          const next = { ...current, subagents: [...(current.subagents ?? []).filter(s => s.taskId !== sdkM.task_id), sa] };
          // Don't return — let it also add to messages below
          onUpdateData(next);
        }
        if (sdkM.type === "system" && sdkM.subtype === "task_progress" && sdkM.task_id) {
          const subs = [...(current.subagents ?? [])];
          const idx = subs.findIndex(s => s.taskId === sdkM.task_id);
          if (idx >= 0) {
            subs[idx] = { ...subs[idx]!, lastTool: sdkM.last_tool_name, summary: sdkM.summary ?? subs[idx]!.summary, tokenCount: sdkM.usage?.total_tokens as number | undefined, toolUses: sdkM.usage?.tool_uses as number | undefined };
            onUpdateData({ ...current, subagents: subs });
          }
          return; // task_progress is not shown in message feed
        }
        if (sdkM.type === "system" && sdkM.subtype === "task_notification" && sdkM.task_id) {
          const subs = [...(current.subagents ?? [])];
          const idx = subs.findIndex(s => s.taskId === sdkM.task_id);
          if (idx >= 0) {
            subs[idx] = { ...subs[idx]!, status: sdkM.status as SubagentInfo["status"] ?? "completed", summary: sdkM.summary ?? subs[idx]!.summary };
            onUpdateData({ ...current, subagents: subs });
          }
          // Fall through to also add to messages
        }

        // Handle prompt suggestions
        if (sdkM.type === "prompt_suggestion" && sdkM.suggestion) {
          onUpdateData({
            ...current,
            promptSuggestions: [...(current.promptSuggestions ?? []).slice(-2), sdkM.suggestion],
          });
          return;
        }

        // Handle init data capture
        if (sdkM.type === "system" && sdkM.subtype === "init") {
          onUpdateData({
            ...current,
            initData: { tools: sdkM.tools, model: sdkM.model, mcp_servers: sdkM.mcp_servers, permissionMode: sdkM.permissionMode },
            model: (sdkM.model as ModelOption) ?? current.model,
          });
        }

        const newMsgs = sdkMessageToSessionMessages(serverMsg.message);
        if (newMsgs.length > 0) {
          const updated = { ...current };
          let base = current.messages;
          // When a result arrives, drop the last assistant msg if its content
          // matches the result — the SDK sends both, but we only want the
          // green result bubble.  Normalize by stripping task-name tags.
          if (serverMsg.message.type === "result") {
            const resultText = newMsgs.find((m) => m.role === "result")?.content;
            if (resultText) {
              const normalizedResult = resultText.replace(/<!--task-name:.+?-->\s*/g, "").trim();
              const lastIdx = base.findLastIndex((m) => m.role === "assistant");
              if (lastIdx >= 0 && base[lastIdx].content.replace(/<!--task-name:.+?-->\s*/g, "").trim() === normalizedResult) {
                base = [...base.slice(0, lastIdx), ...base.slice(lastIdx + 1)];
              }
            }
          }
          updated.messages = [...base, ...newMsgs];
          // When a complete assistant message arrives, clear streaming buffer
          if (serverMsg.message.type === "assistant") {
            updated.streamingText = "";
          }
          if (serverMsg.message.type === "result") {
            updated.status = "idle";
            updated.totalCost =
              serverMsg.message.total_cost_usd ?? current.totalCost;
            updated.turns =
              serverMsg.message.num_turns ?? current.turns;
            updated.streamingText = "";
            updated.modelUsage = serverMsg.message.modelUsage ?? current.modelUsage;
            updated.lastDurationMs = serverMsg.message.duration_ms ?? current.lastDurationMs;
            updated.promptSuggestions = []; // clear old suggestions on new turn
          }
          onUpdateData(updated);
        }
        return;
      }

      if (
        serverMsg.type === "session_status" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        onUpdateData({
          ...current,
          status: serverMsg.status as ClaudeSessionData["status"],
        });
        return;
      }

      if (
        serverMsg.type === "session_error" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        onUpdateData({
          ...current,
          status: "error" as const,
          error: serverMsg.error,
        });
      }
    });
  }, [socketSubscribe, onUpdateData, processSdkEvent]);

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

  const handleModelChange = useCallback(
    (model: ModelOption) => {
      const current = dataRef.current;
      onUpdateData({ ...current, model });
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
      {/* Header */}
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

      {/* Status banners */}
      <StatusBannerStack banners={banners} onDismiss={dismissBanner} />

      {/* Session control toolbar */}
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
      />

      {/* Messages */}
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
        {/* Streaming partial text with blinking cursor */}
        {data.streamingText ? (
          <StreamingBubble text={data.streamingText} borderColor="var(--streaming-color)" />
        ) : data.status === "running" && data.messages.length > 0 ? (
          <StreamingIndicator />
        ) : null}
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

      {/* Active subagents panel */}
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

      {/* Prompt suggestions */}
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

      {/* Input */}
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

      {/* Error display */}
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
});
