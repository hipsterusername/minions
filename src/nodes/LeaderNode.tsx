import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { NodeRenderProps, ThinkingConfig } from "../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, LEADER_CONTRACT } from "../graph.ts";
import type { ServerMessage } from "../use-socket.ts";
import { msgId as sharedMsgId, type DisplayMessage } from "../sdk-messages.ts";
import { LEADER_SYSTEM_PROMPT } from "../prompts/leader-system.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { StreamingBubble, StreamingIndicator } from "../components/StreamingBubble.tsx";
import { type SessionStreamState } from "../session-stream.ts";
import { useSessionStream } from "../use-session-stream.ts";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { ModelOption, PermissionMode } from "../components/SessionToolbar.tsx";
import { getSkill, getAllSkills } from "../skills/registry.ts";
import { compileSkills } from "../skills/types.ts";
import type { SkillTemplate } from "../skills/types.ts";
import { ResizeHandle } from "../components/ResizeHandle.tsx";
import { AutoTextarea } from "../components/AutoTextarea.tsx";
import { SimpleMarkdown } from "../components/SimpleMarkdown.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { AddAsNodeButton } from "../components/AddAsNodeButton.tsx";

registerContract(LEADER_CONTRACT);

/** A single entry in the leader's task plan. Covers all states. */
export interface TaskPlanItem {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  /** planned → running → completed | failed */
  status: "planned" | "running" | "completed" | "failed";
  /** Who is/was executing this task */
  executor: "leader" | "minion";
  minionSessionKey: string | null;
  result: string | null;
  /** Cost in USD — populated for minion tasks on completion */
  cost: number;
  createdAt: number;
  completedAt: number | null;
  /** Last few assistant messages from the minion session (tooltip detail) */
  sessionSummary: string;
}

export interface LeaderData {
  sessionKey: string | null;
  status: "disconnected" | "creating" | "running" | "idle" | "stopped" | "error" | "completed";
  messages: LeaderMessage[];
  /** Accumulated partial text from streaming deltas */
  streamingText: string;
  totalCost: number;
  turns: number;
  error: string | null;
  model: ModelOption;
  permissionMode: PermissionMode;
  /** Adaptive-thinking config sent to the SDK on every query() call. */
  thinkingConfig: ThinkingConfig;
  taskPlan: TaskPlanItem[];
  worktreeIsolation: boolean;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeStatus: "none" | "creating" | "active" | "merging" | "merged" | "discarded" | "failed";
  /** IDs of skills tagged onto this leader */
  skillIds: string[];
  /** Variable values for each skill: { [skillId]: { [varName]: value } } */
  skillValues: Record<string, Record<string, string>>;
  /** Whether the skill config panel is expanded */
  skillPanelOpen: boolean;
  /** If set, auto-start a session with this prompt (then clear it) */
  autoStartPrompt?: string | null;
  /** Display name set by the agent via set_task_name */
  taskName?: string | null;
  /** Wait state: populated when the leader calls wait_and_continue */
  waitUntil?: number | null;
  waitReason?: string | null;
  /** Set briefly after a successful merge to show a confirmation banner */
  mergeConfirmed?: boolean;
  /** Merge conflict state: set when approve & merge fails due to conflicts */
  mergeConflict?: {
    conflicts: string[];
    summary: string;
    targetBranch: string;
  } | null;
  /** Approval state: set when the leader calls request_approval */
  approvalPending?: boolean;
  approvalSummary?: string | null;
  approvalDiff?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: { file: string; insertions: number; deletions: number; status: string }[];
    commits: string[];
    branch: string;
  } | null;
}

// LeaderMessage is now an alias for the shared DisplayMessage type
type LeaderMessage = DisplayMessage;

function msgId(): string {
  return sharedMsgId("lm");
}

/**
 * Project a {@link LeaderData} onto the shared {@link SessionStreamState}
 * shape consumed by {@link useSessionStream}. LeaderData's `status` union
 * is identical to {@link SessionStreamStatus}, so no remapping is needed.
 */
function extractLeaderCore(d: LeaderData): SessionStreamState {
  return {
    sessionKey: d.sessionKey,
    status: d.status,
    messages: d.messages,
    streamingText: d.streamingText,
    totalCost: d.totalCost,
    turns: d.turns,
    error: d.error,
  };
}

/* ── Session context builder for restarts ─────────────────────────── */

/**
 * Build a context block from previous session messages and task plan.
 * Used when restarting a leader session post-disconnect so the new
 * Claude instance understands what happened in the prior session.
 *
 * Returns an empty string if there's nothing meaningful to include.
 */
export function buildSessionContext(
  messages: LeaderMessage[],
  taskPlan: TaskPlanItem[] = [],
  taskName?: string | null,
): string {
  // Only include user/assistant/result messages with meaningful content
  const conversationEntries = messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant" || m.role === "result") &&
        m.content.trim().length > 0,
    )
    .map((m) => {
      const role = m.role === "result" ? "assistant (result)" : m.role;
      // Truncate very long individual messages to keep context manageable
      const content =
        m.content.length > 2000
          ? m.content.slice(0, 1997) + "…"
          : m.content;
      return `[${role}]: ${content}`;
    });

  if (conversationEntries.length === 0 && taskPlan.length === 0) {
    return "";
  }

  const parts: string[] = [];

  parts.push("<previous-session-context>");
  parts.push(
    "This is a CONTINUATION session. A prior session existed in this leader node (it may have completed successfully, been restarted, or lost due to disconnect).",
  );
  parts.push(
    "Below is the conversation history and task state from the prior session.",
  );
  parts.push(
    "Use this to maintain continuity — do NOT repeat completed work. Build on what was already accomplished.\n",
  );

  if (taskName) {
    parts.push(`Session name: ${taskName}\n`);
  }

  // Task plan state
  if (taskPlan.length > 0) {
    parts.push("<task-plan>");
    for (const task of taskPlan) {
      const statusEmoji =
        task.status === "completed"
          ? "✅"
          : task.status === "running"
            ? "🔄"
            : task.status === "failed"
              ? "❌"
              : "📋";
      let line = `${statusEmoji} [${task.status}] ${task.title}`;
      if (task.result) {
        const result =
          task.result.length > 500
            ? task.result.slice(0, 497) + "…"
            : task.result;
        line += ` → ${result}`;
      }
      parts.push(line);
    }
    parts.push("</task-plan>\n");
  }

  // Conversation history — cap at ~30k chars total to stay within context limits
  if (conversationEntries.length > 0) {
    parts.push("<conversation-history>");
    let totalLen = 0;
    const MAX_CONTEXT_CHARS = 30000;
    // Include from newest to oldest, then reverse for chronological order
    const included: string[] = [];
    for (let i = conversationEntries.length - 1; i >= 0; i--) {
      const entry = conversationEntries[i];
      if (totalLen + entry.length > MAX_CONTEXT_CHARS) {
        included.push(
          `[... ${i + 1} earlier messages omitted for brevity ...]`,
        );
        break;
      }
      included.push(entry);
      totalLen += entry.length;
    }
    included.reverse();
    parts.push(included.join("\n\n"));
    parts.push("</conversation-history>");
  }

  parts.push("</previous-session-context>");

  return parts.join("\n");
}

/* ── Wait countdown component ──────────────────────────────────────── */

function WaitCountdown({ waitUntil, reason }: { waitUntil: number; reason: string }) {
  // Capture the total duration once when the component mounts (or waitUntil changes)
  const totalDurationRef = useRef(Math.max(1, waitUntil - Date.now()));
  const [remaining, setRemaining] = useState(() => Math.max(0, waitUntil - Date.now()));

  useEffect(() => {
    totalDurationRef.current = Math.max(1, waitUntil - Date.now());
    const tick = () => setRemaining(Math.max(0, waitUntil - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [waitUntil]);

  const totalSecs = Math.ceil(remaining / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const display = mins > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${secs}s`;

  // Progress bar: fraction of total duration that has elapsed
  const elapsed = 1 - (remaining / totalDurationRef.current);

  return (
    <div
      style={{
        margin: "8px 10px",
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--bg-tertiary, #1a1a2e)",
        border: "1px solid var(--accent, #6c63ff)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 16 }}>⏳</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
          Waiting — resuming in {display}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.3 }}>
        {reason}
      </div>
      {/* Progress bar */}
      <div
        style={{
          height: 3,
          borderRadius: 2,
          background: "var(--border-default, #333)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, elapsed * 100)}%`,
            background: "var(--accent, #6c63ff)",
            borderRadius: 2,
            transition: "width 1s linear",
          }}
        />
      </div>
    </div>
  );
}

/* ── Inline editable title ──────────────────────────────────────────── */

function EditableTitle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when value changes externally
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <span
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        style={{ cursor: "default", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={`${value} (double-click to rename)`}
      >
        {value}
      </span>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    onChange(trimmed || value);
    setEditing(false);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value); setEditing(false); }
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        all: "unset",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-primary)",
        background: "var(--bg-primary)",
        border: "1px solid var(--border-active)",
        borderRadius: 3,
        padding: "1px 4px",
        width: "100%",
        minWidth: 40,
        boxSizing: "border-box",
      }}
    />
  );
}

/* ── Tool group helpers (Leader purple theme) ────────────────────────── */

type LeaderMessageGroup =
  | { kind: "single"; msg: LeaderMessage }
  | { kind: "tool-group"; msgs: LeaderMessage[] }
  | { kind: "thinking-group"; msgs: LeaderMessage[] };

function groupMessages(messages: LeaderMessage[]): LeaderMessageGroup[] {
  const groups: LeaderMessageGroup[] = [];
  let toolBatch: LeaderMessage[] = [];
  let thinkingBatch: LeaderMessage[] = [];

  const flushTools = () => {
    if (toolBatch.length > 0) {
      groups.push({ kind: "tool-group", msgs: [...toolBatch] });
      toolBatch = [];
    }
  };

  const flushThinking = () => {
    if (thinkingBatch.length > 0) {
      groups.push({ kind: "thinking-group", msgs: [...thinkingBatch] });
      thinkingBatch = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === "tool") {
      flushThinking();
      toolBatch.push(msg);
    } else if (msg.role === "thinking") {
      flushTools();
      thinkingBatch.push(msg);
    } else {
      flushTools();
      flushThinking();
      groups.push({ kind: "single", msg });
    }
  }
  flushTools();
  flushThinking();
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

  // Show the most relevant field(s) based on tool type
  switch (toolName) {
    case "Read":
      return input.file_path as string ?? null;
    case "Write":
      return input.file_path as string ?? null;
    case "Edit":
      return input.file_path as string ?? null;
    case "Bash":
      return input.command as string ?? null;
    case "Glob":
      return input.pattern as string ?? null;
    case "Grep":
      return input.pattern as string ?? null;
    case "Agent":
      return input.description as string ?? input.prompt as string ?? null;
    case "WebFetch":
      return input.url as string ?? null;
    case "WebSearch":
      return input.query as string ?? null;
    default: {
      // Generic: show first string value
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

function ToolItem({ msg, accentColor }: { msg: LeaderMessage | DisplayMessage; accentColor: string }) {
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

function LeaderToolGroup({ msgs }: { msgs: LeaderMessage[] }) {
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
          padding: "4px 8px",
          background: expanded ? "var(--tool-bg)" : "transparent",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          textAlign: "left",
          transition: "color 0.15s, background 0.15s",
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
            background: "var(--tool-bg-hover)",
            color: "var(--tool-accent)",
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
              <ToolItem key={m.id} msg={m} accentColor="var(--tool-accent)" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LeaderThinkingGroup({
  msgs,
  effort,
}: {
  msgs: LeaderMessage[];
  effort?: ThinkingConfig["effort"];
}) {
  const [expanded, setExpanded] = useState(false);
  const totalLen = msgs.reduce((sum, m) => sum + m.content.length, 0);
  const estTokens = Math.round(totalLen / 4);
  const tokenLabel = estTokens >= 1000 ? `~${(estTokens / 1000).toFixed(1)}k tokens` : `~${estTokens} tokens`;

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
          padding: "4px 8px",
          background: expanded ? "var(--thinking-bg)" : "transparent",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          textAlign: "left",
          transition: "color 0.15s, background 0.15s",
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
            fontSize: 10,
            borderRadius: 3,
            background: "var(--thinking-bg-hover)",
            color: "var(--thinking-accent)",
            flexShrink: 0,
            transition: "transform 0.2s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          &#9654;
        </span>
        <span style={{ opacity: 0.7, color: "var(--thinking-accent)" }}>Thinking</span>
        {effort && (
          <span
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--thinking-bg-hover)",
              color: "var(--thinking-accent)",
              opacity: 0.85,
              textTransform: "lowercase",
              letterSpacing: 0.2,
            }}
            title={`Adaptive thinking · effort: ${effort}`}
          >
            {effort}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            opacity: 0.4,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {tokenLabel}
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
              paddingBlock: 4,
              paddingInline: 10,
              maxHeight: 200,
              overflowY: "auto",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowWrap: "break-word",
              fontStyle: "italic",
              borderLeft: "2px solid var(--thinking-accent)",
              marginLeft: 8,
            }}
          >
            {msgs.map((m) => m.content).join("\n\n")}
          </div>
        </div>
      </div>
    </div>
  );
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: "var(--priority-critical)",
  high: "var(--priority-high)",
  medium: "var(--warning-color)",
  low: "var(--streaming-color)",
};

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/* ── P5: Collapsible user message ─────────────────────────────────────── */

function UserMessageBubble({ msg }: { msg: LeaderMessage }) {
  const [collapsed, setCollapsed] = useState(msg.content.length > 300);
  const isLong = msg.content.length > 300;

  return (
    <div
      className="copyable"
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.6,
        fontFamily: "var(--font-sans)",
        color: "var(--accent)",
        borderLeft: "2px solid var(--accent)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "break-word",
        position: "relative",
      }}
    >
      <CopyButton text={msg.content} />
      {collapsed ? msg.content.slice(0, 200) + "…" : msg.content}
      {isLong && (
        <button
          onClick={() => setCollapsed(!collapsed)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            display: "inline-block",
            marginLeft: 6,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--accent)",
            background: "none",
            border: "none",
            cursor: "pointer",
            textDecoration: "underline",
            opacity: 0.7,
            padding: 0,
          }}
        >
          {collapsed ? "show more" : "show less"}
        </button>
      )}
    </div>
  );
}

/* ── P4: Task Plan Panel ──────────────────────────────────────────────── */
// Shows the full task lifecycle: planned → running → completed/failed.
// Driven entirely by taskPlan[] which is populated from deterministic
// server-side task_plan_update broadcasts and minion completion events.

const TASK_STATUS_ICON: Record<TaskPlanItem["status"], string> = {
  planned: "○",
  running: "◎",
  completed: "✓",
  failed: "✗",
};

const TASK_STATUS_COLOR: Record<TaskPlanItem["status"], string> = {
  planned: "var(--text-muted)",
  running: "var(--status-creating)",
  completed: "var(--success-color)",
  failed: "var(--danger-color)",
};

function TaskPlanPanel({
  taskPlan,
  expanded,
  onToggle,
  onRevealMinion,
}: {
  taskPlan: TaskPlanItem[];
  expanded: boolean;
  onToggle: () => void;
  onRevealMinion?: (minionSessionKey: string) => void;
}) {
  const [hoveredTask, setHoveredTask] = useState<number | null>(null);
  const [tooltipAnchor, setTooltipAnchor] = useState<DOMRect | null>(null);

  if (taskPlan.length === 0) return null;

  const completedCount = taskPlan.filter(
    (t) => t.status === "completed" || t.status === "failed",
  ).length;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border-default)",
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "transparent",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border-default)" : "none",
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            fontSize: 8,
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            color: "var(--text-muted)",
          }}
        >
          &#9654;
        </span>
        <span style={{ flex: 1 }}>
          Plan{" "}
          <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
            ({completedCount}/{taskPlan.length})
          </span>
        </span>
        {/* Live running indicator */}
        {taskPlan.some((t) => t.status === "running") && (
          <span style={{ color: "var(--status-creating)", fontSize: 9, opacity: 0.8 }}>
            {taskPlan.filter((t) => t.status === "running").length} running
          </span>
        )}
      </button>

      {/* Task list */}
      {expanded && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            maxHeight: 220,
            overflowY: "auto",
            padding: "4px 12px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {taskPlan.map((task, idx) => {
            const isMinion = task.executor === "minion";
            const canReveal = isMinion && onRevealMinion && (task.minionSessionKey || task.taskId);
            return (
            <div
              key={task.taskId}
              onMouseEnter={(e) => { setHoveredTask(idx); setTooltipAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()); }}
              onMouseLeave={() => { setHoveredTask(null); setTooltipAnchor(null); }}
              onClick={canReveal ? (e) => { e.stopPropagation(); onRevealMinion!(task.minionSessionKey ?? task.taskId); } : undefined}
              onMouseDown={canReveal ? (e) => e.stopPropagation() : undefined}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 6px",
                borderRadius: 4,
                background: hoveredTask === idx ? "var(--bg-elevated)" : "transparent",
                cursor: canReveal ? "pointer" : "default",
                opacity: task.status === "planned" ? 0.6 : 1,
              }}
            >
              {/* Status icon */}
              <span
                style={{
                  fontSize: 11,
                  color: TASK_STATUS_COLOR[task.status],
                  flexShrink: 0,
                  width: 14,
                  textAlign: "center",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {TASK_STATUS_ICON[task.status]}
              </span>

              {/* Title */}
              <span
                style={{
                  fontSize: 11,
                  color: task.status === "failed" ? "var(--danger-color)" : "var(--text-primary)",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textDecoration: task.status === "failed" ? "line-through" : "none",
                }}
              >
                {task.title}
              </span>

              {/* Executor badge — minion badges hint at click-to-reveal */}
              {task.status !== "planned" && (
                <span
                  style={{
                    fontSize: 9,
                    padding: "1px 4px",
                    borderRadius: 3,
                    background: task.executor === "leader"
                      ? "var(--state-active)"
                      : "var(--success-bg)",
                    color: task.executor === "leader" ? "var(--accent)" : "var(--success-color)",
                    fontFamily: "var(--font-mono)",
                    flexShrink: 0,
                    ...(canReveal ? { textDecoration: "underline", textUnderlineOffset: 2 } : {}),
                  }}
                  title={canReveal ? "Click to view minion" : undefined}
                >
                  {task.executor === "leader" ? "self" : canReveal ? "▸ minion" : "minion"}
                </span>
              )}

              {/* Priority */}
              <span
                style={{
                  fontSize: 9,
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: PRIORITY_COLORS[task.priority] ?? "var(--text-muted)",
                  color: task.priority === "medium" ? "var(--bg-primary)" : "var(--text-primary)",
                  fontWeight: 600,
                  flexShrink: 0,
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                }}
              >
                {task.priority}
              </span>

              {/* Cost (minion tasks only, on completion) */}
              {task.cost > 0 && (
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    flexShrink: 0,
                  }}
                >
                  ${task.cost.toFixed(4)}
                </span>
              )}

              {/* Time */}
              {task.completedAt != null && (
                <span
                  style={{
                    fontSize: 9,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    flexShrink: 0,
                  }}
                >
                  {timeAgo(task.completedAt)}
                </span>
              )}

              {/* Hover tooltip — rendered via portal to escape overflow:hidden/auto containers */}
              {hoveredTask === idx && tooltipAnchor && (task.description || task.result || task.sessionSummary) &&
                createPortal(
                  <div
                    style={{
                      position: "fixed",
                      top: tooltipAnchor.top - 6,
                      left: tooltipAnchor.left,
                      transform: "translateY(-100%)",
                      zIndex: 99999,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 8,
                      padding: 12,
                      maxWidth: 360,
                      boxShadow: "var(--shadow-lg)",
                      pointerEvents: "none",
                    }}
                  >
                    {task.description && (
                      <div style={{ fontSize: 11, color: "var(--text-primary)", marginBottom: 6, lineHeight: 1.4 }}>
                        {task.description.length > 200
                          ? task.description.slice(0, 200) + "…"
                          : task.description}
                      </div>
                    )}
                    {task.minionSessionKey && (
                      <div
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-muted)",
                          marginBottom: 4,
                          opacity: 0.7,
                        }}
                      >
                        {task.minionSessionKey}
                      </div>
                    )}
                    {(task.result || task.sessionSummary) && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--text-secondary, var(--text-muted))",
                          lineHeight: 1.4,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 120,
                          overflowY: "auto",
                        }}
                      >
                        {task.result ?? task.sessionSummary}
                      </div>
                    )}
                  </div>,
                  document.body,
                )
              }
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── P3: Skills Flyout (floating panel instead of inline) ─────────────── */

const SKILL_CATEGORIES: { key: string; label: string }[] = [
  { key: "code", label: "Code" },
  { key: "docs", label: "Docs" },
  { key: "testing", label: "Testing" },
  { key: "devops", label: "DevOps" },
  { key: "analysis", label: "Analysis" },
  { key: "design", label: "Design" },
  { key: "general", label: "General" },
];

function SkillTagChip({
  skill,
  onRemove,
  readOnly,
}: {
  skill: SkillTemplate;
  onRemove?: () => void;
  readOnly: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        background: `${skill.accentColor}20`,
        border: `1px solid ${skill.accentColor}40`,
        color: skill.accentColor,
      }}
    >
      <span>{skill.icon}</span>
      <span>{skill.name}</span>
      {!readOnly && onRemove && (
        <button
          onClick={onRemove}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            background: "none",
            border: "none",
            color: skill.accentColor,
            cursor: "pointer",
            padding: 0,
            fontSize: 10,
            lineHeight: 1,
            opacity: 0.6,
          }}
        >
          ✕
        </button>
      )}
    </span>
  );
}

function SkillVariableInputs({
  skill,
  values,
  onChange,
  readOnly,
}: {
  skill: SkillTemplate;
  values: Record<string, string>;
  onChange: (varName: string, value: string) => void;
  readOnly: boolean;
}) {
  if (skill.variables.length === 0) return null;

  return (
    <div style={{ padding: "6px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: skill.accentColor,
          opacity: 0.8,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontWeight: 600,
        }}
      >
        {skill.icon} {skill.name}
      </div>
      {skill.variables.map((v) => (
        <div key={v.name} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <label
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {v.label}
            {v.required && (
              <span style={{ color: "var(--danger-color)", fontSize: 10 }}>*</span>
            )}
          </label>
          {v.type === "select" ? (
            <select
              value={values[v.name] ?? v.defaultValue ?? ""}
              onChange={(e) => onChange(v.name, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={readOnly}
              style={{
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-primary)",
                outline: "none",
                opacity: readOnly ? 0.6 : 1,
              }}
            >
              {v.options?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : v.type === "textarea" ? (
            <textarea
              value={values[v.name] ?? v.defaultValue ?? ""}
              onChange={(e) => onChange(v.name, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              readOnly={readOnly}
              placeholder={v.placeholder}
              rows={2}
              style={{
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-primary)",
                outline: "none",
                resize: "vertical",
                opacity: readOnly ? 0.6 : 1,
              }}
            />
          ) : (
            <input
              type="text"
              value={values[v.name] ?? v.defaultValue ?? ""}
              onChange={(e) => onChange(v.name, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              readOnly={readOnly}
              placeholder={v.placeholder}
              style={{
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-primary)",
                outline: "none",
                opacity: readOnly ? 0.6 : 1,
              }}
            />
          )}
          {v.description && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {v.description}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const FLYOUT_W = 680;
const FLYOUT_H = 480;
const FLYOUT_GAP = 6; // px below anchor

function SkillFlyout({
  skillIds,
  skillValues,
  open,
  readOnly,
  anchorRef,
  onUpdate,
  onClose,
}: {
  skillIds: string[];
  skillValues: Record<string, Record<string, string>>;
  open: boolean;
  readOnly: boolean;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onUpdate: (patch: {
    skillIds?: string[];
    skillValues?: Record<string, Record<string, string>>;
    skillPanelOpen?: boolean;
  }) => void;
  onClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const el = anchorRef?.current;
    if (!el) { setPos(null); return; }

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer opening below the anchor; flip above if it would clip
    let top = rect.bottom + FLYOUT_GAP;
    if (top + FLYOUT_H > vh - 8) top = rect.top - FLYOUT_H - FLYOUT_GAP;

    // Left-align with anchor, clamp to viewport
    let left = rect.left;
    if (left + FLYOUT_W > vw - 8) left = vw - FLYOUT_W - 8;
    if (left < 8) left = 8;

    setPos({ top, left });
  }, [open, anchorRef]);

  const allSkills = getAllSkills();
  const taggedSkills = skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);

  const handleAddSkill = (id: string) => {
    if (!skillIds.includes(id)) {
      onUpdate({ skillIds: [...skillIds, id], skillPanelOpen: true });
    }
  };

  const handleRemoveSkill = (id: string) => {
    const next = skillIds.filter((s) => s !== id);
    const nextValues = { ...skillValues };
    delete nextValues[id];
    onUpdate({ skillIds: next, skillValues: nextValues });
  };

  const handleVarChange = (skillId: string, varName: string, value: string) => {
    const current = skillValues[skillId] ?? {};
    onUpdate({ skillValues: { ...skillValues, [skillId]: { ...current, [varName]: value } } });
  };

  // Filter available skills by search + category (show all when readOnly)
  const query = searchQuery.toLowerCase().trim();
  const browseByCategory = SKILL_CATEGORIES
    .map((cat) => ({
      ...cat,
      skills: allSkills.filter(
        (s) =>
          s.category === cat.key &&
          (readOnly ? skillIds.includes(s.id) : !skillIds.includes(s.id)) &&
          (query === "" ||
            s.name.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query)),
      ),
    }))
    .filter((cat) => cat.skills.length > 0);

  if (!open) return null;

  const flyoutContent = (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />

      {/* Wide split-panel modal — anchored below the skills button */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: pos?.top ?? 120,
          left: pos?.left ?? 120,
          zIndex: 9999,
          width: FLYOUT_W,
          height: FLYOUT_H,
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* ── Modal header ── */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg-primary)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>⚡</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>
              Skills
            </span>
            {taggedSkills.length > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  padding: "1px 6px",
                  borderRadius: 10,
                  background: "var(--state-active)",
                  color: "var(--accent)",
                  border: "1px solid var(--accent)",
                }}
              >
                {taggedSkills.length} active
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 16,
              padding: "0 2px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Body: left browser + right config ── */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>

          {/* LEFT PANEL — skill browser */}
          <div
            style={{
              width: 220,
              flexShrink: 0,
              borderRight: "1px solid var(--border-default)",
              display: "flex",
              flexDirection: "column",
              background: "var(--bg-primary)",
            }}
          >
            {/* Search */}
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-default)", flexShrink: 0 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder="Search skills…"
                style={{
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 5,
                  color: "var(--text-primary)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* Skill list — scrollable */}
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "4px 6px 8px" }}>
              {browseByCategory.length === 0 && (
                <div style={{ padding: "16px 8px", fontSize: 11, color: "var(--text-muted)", textAlign: "center", fontFamily: "var(--font-mono)" }}>
                  {query ? "No matches" : readOnly ? "No skills" : "All added ✓"}
                </div>
              )}
              {browseByCategory.map((cat) => (
                <div key={cat.key}>
                  <div
                    style={{
                      fontSize: 9,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-muted)",
                      padding: "8px 6px 3px",
                      textTransform: "uppercase",
                      letterSpacing: 0.6,
                    }}
                  >
                    {cat.label}
                  </div>
                  {cat.skills.map((skill) => (
                    <button
                      key={skill.id}
                      onClick={() => !readOnly && handleAddSkill(skill.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      disabled={readOnly}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 7,
                        width: "100%",
                        padding: "6px 6px",
                        background: "transparent",
                        border: "none",
                        borderRadius: 5,
                        color: "var(--text-primary)",
                        fontSize: 11,
                        cursor: readOnly ? "default" : "pointer",
                        textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (!readOnly) e.currentTarget.style.background = "var(--bg-elevated)";
                      }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ fontSize: 13, lineHeight: 1.3, flexShrink: 0 }}>{skill.icon}</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {skill.name}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.3 }}>
                          {skill.description.length > 55
                            ? skill.description.slice(0, 55) + "…"
                            : skill.description}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT PANEL — active skills config */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

            {/* TOP GUTTER — active skill chips, single scrollable row */}
            <div
              style={{
                position: "relative",
                borderBottom: "1px solid var(--border-default)",
                flexShrink: 0,
                background: "var(--state-hover)",
              }}
            >
              <div
                style={{
                  padding: "6px 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "nowrap",
                  overflowX: "auto",
                  scrollbarWidth: "none",
                  msOverflowStyle: "none",
                  minHeight: 38,
                  // hide webkit scrollbar via inline won't work — handled by className below
                }}
              >
                {taggedSkills.length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontStyle: "italic", whiteSpace: "nowrap" }}>
                    No skills selected — pick from the left panel
                  </span>
                ) : (
                  taggedSkills.map((skill) => (
                    <SkillTagChip
                      key={skill.id}
                      skill={skill}
                      readOnly={readOnly}
                      onRemove={() => handleRemoveSkill(skill.id)}
                    />
                  ))
                )}
              </div>
              {/* Right-edge fade when chips overflow */}
              {taggedSkills.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: 32,
                    background: "linear-gradient(to right, transparent, var(--state-hover))",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>

            {/* MAIN CONFIG AREA — scrollable, position:relative gives concrete bounds */}
            <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
            <div style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
              {taggedSkills.length === 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    gap: 10,
                    color: "var(--text-muted)",
                  }}
                >
                  <span style={{ fontSize: 32, opacity: 0.3 }}>⚡</span>
                  <span style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
                    Add skills to configure them here
                  </span>
                </div>
              )}
              {taggedSkills.map((skill) => (
                <div
                  key={skill.id}
                  style={{
                    background: "var(--bg-primary)",
                    border: `1px solid ${skill.accentColor}30`,
                    borderRadius: 7,
                    overflow: "hidden",
                    flexShrink: 0,
                  }}
                >
                  {/* Skill config header */}
                  <div
                    style={{
                      padding: "8px 12px",
                      borderBottom: `1px solid ${skill.accentColor}20`,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: `${skill.accentColor}10`,
                    }}
                  >
                    <span style={{ fontSize: 15 }}>{skill.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: skill.accentColor, fontFamily: "var(--font-mono)" }}>
                        {skill.name}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>
                        {skill.description}
                      </div>
                    </div>
                    {!readOnly && (
                      <button
                        onClick={() => handleRemoveSkill(skill.id)}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          fontSize: 12,
                          padding: "2px 4px",
                          borderRadius: 3,
                          lineHeight: 1,
                          flexShrink: 0,
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {/* Variable inputs (or empty state) */}
                  {skill.variables.length === 0 ? (
                    <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                      No configuration needed.
                    </div>
                  ) : (
                    <div style={{ padding: "10px 12px" }}>
                      <SkillVariableInputs
                        skill={skill}
                        values={skillValues[skill.id] ?? {}}
                        onChange={(varName, value) => handleVarChange(skill.id, varName, value)}
                        readOnly={readOnly}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
              {/* Bottom fade — suggests scrollability */}
              <div
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 28,
                  background: "linear-gradient(to bottom, transparent, var(--bg-secondary))",
                  pointerEvents: "none",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(flyoutContent, document.body);
}

/* ── P4: Compact config footer (worktree + context in one bar) ────────── */

function ConfigFooter({
  data,
  onUpdateData,
  socketSend,
  getContextForNode,
}: {
  data: LeaderData;
  onUpdateData: (d: LeaderData) => void;
  socketSend?: (data: unknown) => void;
  getContextForNode?: () => import("../types.ts").ContextItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  const contextCount = getContextForNode?.().length ?? 0;
  const hasSession = !!data.sessionKey;

  // Worktree status indicators (merged, merging, discarded, failed) shown inline
  const wtStatus = data.worktreeStatus;
  const showWorktreeActions = wtStatus === "active" && data.status === "idle";
  const showWorktreeStatusBadge =
    wtStatus === "merging" || wtStatus === "merged" || wtStatus === "discarded" || wtStatus === "failed";

  return (
    <div
      style={{
        borderTop: "1px solid var(--border-default)",
        background: "var(--bg-secondary)",
        flexShrink: 0,
      }}
    >
      {/* Compact summary row — always visible */}
      <div
        onClick={() => setExpanded(!expanded)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          padding: "4px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          userSelect: "none",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {/* Worktree badge */}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "1px 6px",
            borderRadius: 3,
            background: data.worktreeIsolation
              ? "var(--state-active)"
              : "var(--state-hover)",
            color: data.worktreeIsolation ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          {"\u{1F33F}"} {data.worktreeIsolation ? "isolated" : "shared"}
        </span>

        {/* Context count — locked after session starts */}
        {contextCount > 0 && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              color: hasSession ? "var(--text-muted)" : "var(--accent)",
              opacity: hasSession ? 0.7 : 1,
            }}
          >
            {hasSession ? "\u{1F512}" : "\u{1F4CE}"} {contextCount}
          </span>
        )}

        {/* Worktree branch */}
        {data.worktreeBranch && (
          <span style={{ color: "var(--accent)", fontSize: 9 }}>
            {data.worktreeBranch}
          </span>
        )}

        {/* Worktree status badge */}
        {showWorktreeStatusBadge && (
          <span
            style={{
              color: wtStatus === "merged" ? "var(--success-color)" : wtStatus === "failed" ? "var(--danger-color)" : wtStatus === "discarded" ? "var(--status-error)" : "var(--status-creating)",
            }}
          >
            {wtStatus === "merging" ? "merging..." : wtStatus === "merged" ? "merged" : wtStatus === "failed" ? "isolation failed" : "discarded"}
          </span>
        )}

        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 8,
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 0.15s",
          }}
        >
          ▼
        </span>
      </div>

      {/* Expanded config */}
      {expanded && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ padding: "4px 10px 8px" }}
        >
          {/* Worktree isolation toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <button
              onClick={() => {
                if (!hasSession) {
                  onUpdateData({ ...data, worktreeIsolation: !data.worktreeIsolation });
                }
              }}
              disabled={hasSession}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "4px 10px",
                borderRadius: 4,
                border: "none",
                cursor: hasSession ? "default" : "pointer",
                opacity: hasSession ? 0.7 : 1,
                background: data.worktreeIsolation
                  ? "var(--state-active)"
                  : "var(--state-hover)",
                color: data.worktreeIsolation ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              {"\u{1F33F}"} Worktree Isolation
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: data.worktreeIsolation ? "var(--accent)" : "var(--text-muted)",
                  marginLeft: 2,
                }}
              />
            </button>
          </div>

          {/* Context sources — locked after session starts */}
          {contextCount > 0 && (
            <div
              style={{
                fontSize: 10,
                color: hasSession ? "var(--text-muted)" : "var(--accent)",
                fontFamily: "var(--font-mono)",
                display: "flex",
                alignItems: "center",
                gap: 4,
                marginBottom: 4,
                opacity: hasSession ? 0.7 : 1,
              }}
            >
              {hasSession ? "\u{1F512}" : "\u{1F4CE}"}{" "}
              {contextCount} context source{contextCount !== 1 ? "s" : ""}
              {hasSession ? " (locked)" : " connected"}
            </div>
          )}

          {/* Worktree failure warning */}
          {wtStatus === "failed" && (
            <div
              style={{
                marginTop: 4,
                padding: "6px 8px",
                background: "var(--danger-bg)",
                border: "1px solid var(--danger-color)",
                borderRadius: 4,
                fontSize: 10,
                color: "var(--status-error)",
                lineHeight: 1.4,
              }}
            >
              <strong>Isolation failed:</strong> This session is operating directly on your working tree.
              Changes will not be isolated in a branch.
            </div>
          )}

          {/* Worktree actions (shown when idle with active worktree but NOT when approval is pending) */}
          {/* NOTE: No manual "Merge" button — merging happens only through the approval workflow */}
          {/* (the agent calls request_approval → user clicks "Approve & Merge"). */}
          {showWorktreeActions && !data.approvalPending && (
            <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
              <button
                onClick={() => {
                  if (socketSend && data.sessionKey) {
                    socketSend({ type: "get_worktree_diff", sessionKey: data.sessionKey });
                  }
                }}
                style={{
                  padding: "3px 8px", fontSize: 10, background: "var(--bg-elevated)",
                  border: "1px solid var(--border-default)", borderRadius: 4,
                  color: "var(--text-secondary)", cursor: "pointer", fontFamily: "var(--font-mono)",
                }}
              >
                View Diff
              </button>
              <button
                onClick={() => {
                  if (socketSend && data.sessionKey && confirm("Discard all worktree changes?")) {
                    socketSend({ type: "discard_worktree", sessionKey: data.sessionKey });
                  }
                }}
                style={{
                  padding: "3px 8px", fontSize: 10, background: "var(--danger-bg)",
                  border: "1px solid var(--danger-color)", borderRadius: 4,
                  color: "var(--status-error)", cursor: "pointer", fontFamily: "var(--font-mono)",
                }}
              >
                Discard
              </button>
              <span style={{ fontSize: 9, color: "var(--text-muted)", fontStyle: "italic" }}>
                Agent will request approval when ready to merge
              </span>
            </div>
          )}
        </div>
      )}

      {/* Merge confirmed banner — shown briefly after successful merge */}
      {data.mergeConfirmed && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            margin: "0 6px 6px",
            padding: "10px 12px",
            background: "var(--success-bg, rgba(46,160,67,0.1))",
            border: "2px solid var(--success-color)",
            borderRadius: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--success-color)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14 }}>✓</span> Merged successfully
            </div>
            <button
              onClick={() => onUpdateData({ ...data, mergeConfirmed: false })}
              style={{
                background: "none", border: "none", color: "var(--text-muted)",
                cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1,
              }}
              title="Dismiss"
            >
              x
            </button>
          </div>
          {data.status === "completed" && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Session complete.
              </span>
              <button
                onClick={handleNewSession}
                style={{
                  padding: "4px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--accent)",
                  background: "var(--state-active, rgba(88,166,255,0.1))",
                  color: "var(--accent)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                New Session
              </button>
            </div>
          )}
        </div>
      )}

      {/* Merge conflict panel — shown when approve & merge fails */}
      {data.approvalPending && data.mergeConflict && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            margin: "0 6px 6px",
            padding: "10px 12px",
            background: "var(--danger-bg)",
            border: "2px solid var(--danger-color)",
            borderRadius: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--status-error)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14 }}>!</span> Merge Conflicts
            </div>
            <button
              onClick={() => onUpdateData({ ...data, mergeConflict: null })}
              style={{
                background: "none", border: "none", color: "var(--text-muted)",
                cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1,
              }}
              title="Dismiss"
            >
              x
            </button>
          </div>
          {data.mergeConflict.conflicts.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)", background: "var(--bg-elevated)", padding: "6px 8px", borderRadius: 4, maxHeight: 80, overflowY: "auto" }}>
              {data.mergeConflict.conflicts.map((f, i) => (
                <div key={i} style={{ padding: "1px 0" }}>{f}</div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 6, lineHeight: 1.4 }}>
            Choose a resolution strategy:
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-no-drag>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                console.log("[worktree] Keep Ours clicked", { socketSend: !!socketSend, sessionKey: data.sessionKey });
                if (socketSend && data.sessionKey) {
                  socketSend({ type: "force_merge", sessionKey: data.sessionKey });
                  onUpdateData({ ...data, worktreeStatus: "merging", mergeConflict: null, approvalPending: false });
                }
              }}
              style={{
                padding: "5px 12px", fontSize: 11, fontWeight: 600,
                background: "var(--accent)", border: "none", borderRadius: 6,
                color: "var(--text-primary)", cursor: "pointer", fontFamily: "var(--font-mono)",
              }}
              title="Keep canvas branch changes where conflicts occur"
            >
              Keep Ours
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                console.log("[worktree] Keep Main clicked", { socketSend: !!socketSend, sessionKey: data.sessionKey });
                if (socketSend && data.sessionKey) {
                  socketSend({ type: "theirs_merge", sessionKey: data.sessionKey });
                  onUpdateData({ ...data, worktreeStatus: "merging", mergeConflict: null, approvalPending: false });
                }
              }}
              style={{
                padding: "5px 12px", fontSize: 11, fontWeight: 600,
                background: "var(--bg-elevated)", border: "1px solid var(--border-default)", borderRadius: 6,
                color: "var(--text-secondary)", cursor: "pointer", fontFamily: "var(--font-mono)",
              }}
              title="Keep main branch changes where conflicts occur"
            >
              Keep Main
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                console.log("[worktree] Retry clicked", { socketSend: !!socketSend, sessionKey: data.sessionKey });
                if (socketSend && data.sessionKey) {
                  socketSend({ type: "retry_merge", sessionKey: data.sessionKey });
                  onUpdateData({ ...data, worktreeStatus: "merging", mergeConflict: null, approvalPending: false });
                }
              }}
              style={{
                padding: "5px 12px", fontSize: 11,
                background: "var(--bg-elevated)", border: "1px solid var(--border-default)", borderRadius: 6,
                color: "var(--text-secondary)", cursor: "pointer", fontFamily: "var(--font-mono)",
              }}
              title="Re-attempt a clean merge (use after manually resolving conflicts in the worktree)"
            >
              Retry
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (socketSend && data.sessionKey && confirm("Discard all worktree changes?")) {
                  socketSend({ type: "discard_worktree", sessionKey: data.sessionKey });
                }
              }}
              style={{
                padding: "5px 12px", fontSize: 11,
                background: "var(--danger-bg)", border: "1px solid var(--danger-color)", borderRadius: 6,
                color: "var(--status-error)", cursor: "pointer", fontFamily: "var(--font-mono)",
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Approval pending banner — shown when no conflicts (normal flow) */}
      {data.approvalPending && !data.mergeConflict && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            margin: "0 6px 6px",
            padding: "10px 12px",
            background: "var(--state-active)",
            border: "2px solid var(--accent)",
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 14 }}>✓</span> Changes Ready for Review
          </div>
          {data.approvalSummary && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 8, lineHeight: 1.5 }}>
              {data.approvalSummary}
            </div>
          )}
          {data.approvalDiff && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
              {data.approvalDiff.filesChanged} file{data.approvalDiff.filesChanged !== 1 ? "s" : ""} changed
              {" · "}
              <span style={{ color: "var(--success-color)", fontWeight: 600 }}>+{data.approvalDiff.insertions}</span>
              {" "}
              <span style={{ color: "var(--status-error)", fontWeight: 600 }}>-{data.approvalDiff.deletions}</span>
              {data.approvalDiff.commits.length > 0 && (
                <span> {" · "} {data.approvalDiff.commits.length} commit{data.approvalDiff.commits.length !== 1 ? "s" : ""}</span>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                if (socketSend && data.sessionKey) {
                  socketSend({ type: "approve_changes", sessionKey: data.sessionKey });
                  onUpdateData({ ...data, worktreeStatus: "merging", approvalPending: false });
                }
              }}
              style={{
                padding: "6px 16px", fontSize: 12, fontWeight: 700,
                background: "var(--success-color)", border: "none", borderRadius: 6,
                color: "var(--text-primary)", cursor: "pointer", fontFamily: "var(--font-mono)",
              }}
            >
              ✓ Approve & Merge
            </button>
            <button
              onClick={() => {
                if (socketSend && data.sessionKey) {
                  socketSend({ type: "get_worktree_diff", sessionKey: data.sessionKey });
                }
              }}
              style={{
                padding: "6px 12px", fontSize: 11, background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)", borderRadius: 6,
                color: "var(--text-secondary)", cursor: "pointer", fontFamily: "var(--font-mono)",
              }}
            >
              View Diff
            </button>
            <button
              onClick={() => {
                if (socketSend && data.sessionKey && confirm("Discard all worktree changes?")) {
                  socketSend({ type: "discard_worktree", sessionKey: data.sessionKey });
                }
              }}
              style={{
                padding: "6px 12px", fontSize: 11, background: "var(--danger-bg)",
                border: "1px solid var(--danger-color)", borderRadius: 6,
                color: "var(--status-error)", cursor: "pointer", fontFamily: "var(--font-mono)",
              }}
            >
              Discard
            </button>
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, fontStyle: "italic" }}>
            Send a message to request changes instead
          </div>
        </div>
      )}
    </div>
  );
}

/* ── P6: Header menu ──────────────────────────────────────────────────── */

function HeaderMenu({
  onReset,
  onExportLog,
  data,
  canvasScale,
}: {
  onReset: () => void;
  onExportLog: () => void;
  data: LeaderData;
  canvasScale?: number;
}) {
  const [open, setOpen] = useState(false);

  // Close menu when canvas zoom level changes
  const prevScaleRef = useRef(canvasScale);
  useEffect(() => {
    if (prevScaleRef.current !== canvasScale) {
      prevScaleRef.current = canvasScale;
      setOpen(false);
    }
  }, [canvasScale]);

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 14,
          padding: "2px 4px",
          lineHeight: 1,
          borderRadius: 3,
          transition: "color 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
      >
        ⋮
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 998 }}
          />
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              zIndex: 999,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
              minWidth: 160,
            }}
          >
            <button
              onClick={() => { onExportLog(); setOpen(false); }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 12px",
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-surface)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ opacity: 0.6 }}>↗</span> Export Log
            </button>
            {data.sessionKey && (
              <button
                onClick={() => { onReset(); setOpen(false); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  background: "transparent",
                  border: "none",
                  color: "var(--status-error)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--danger-bg)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ opacity: 0.6 }}>↺</span> Reset Session
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────────────── */

export function LeaderNodeRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  getContextForNode,
  projectPath,
  onResize,
  onAddContentNode,
  onRevealMinion,
  canvasScale,
}: NodeRenderProps) {
  const data = node.data as LeaderData;
  const dataRef = useRef(data);
  dataRef.current = data;

  const [input, setInput] = useState("");
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [skillFlyoutOpen, setSkillFlyoutOpen] = useState(false);
  const [scrollLocked, setScrollLocked] = useState(false);
  const skillAnchorRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const scrollZoneRef = useRef<HTMLDivElement>(null);
  const syncedRef = useRef(false);
  const { banners, processSdkEvent, dismissBanner } = useStatusBanners();

  // Auto-expand the plan panel when the first task is registered
  const prevPlanCountRef = useRef(0);
  useEffect(() => {
    const count = data.taskPlan?.length ?? 0;
    if (count > 0 && prevPlanCountRef.current === 0) {
      setTasksExpanded(true);
    }
    prevPlanCountRef.current = count;
  }, [data.taskPlan]);

  // Close flyout panels when canvas zoom level changes
  const prevScaleRef = useRef(canvasScale);
  useEffect(() => {
    if (prevScaleRef.current !== canvasScale) {
      prevScaleRef.current = canvasScale;
      setSkillFlyoutOpen(false);
    }
  }, [canvasScale]);

  // Click-outside: deactivate scroll lock when clicking outside the scroll zone
  useEffect(() => {
    if (!scrollLocked) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (scrollZoneRef.current && !scrollZoneRef.current.contains(e.target as Node)) {
        setScrollLocked(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [scrollLocked]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [data.messages.length]);

  useEffect(() => {
    if (!socketSend || !data.sessionKey || syncedRef.current) return;
    syncedRef.current = true;
    socketSend({ type: "sync_session", sessionKey: data.sessionKey });
  }, [socketSend, data.sessionKey]);

  // Helper: update dataRef *synchronously* so rapid-fire WS events within the
  // same frame each see the latest state, then dispatch to React.
  const emitUpdate = useCallback(
    (next: LeaderData) => {
      dataRef.current = next;
      onUpdateData(next);
    },
    [onUpdateData],
  );

  // ── Shared session-stream concerns via the controlled hook ────────
  //
  // The hook owns the WebSocket subscription for messages, status,
  // cost, turns, error and streaming-text deltas. Node-specific
  // reactions to session_status (clearing waitUntil when the session
  // resumes) are layered into applyCoreUpdate. All other node-specific
  // events — session_task_name, wait_state, worktree_*, approval_*,
  // and the extra worktree/taskName/approval fields on sync_response
  // — live in the secondary subscription below.
  const applyCoreUpdate = useCallback(
    (next: SessionStreamState) => {
      const current = dataRef.current;

      let merged: LeaderData = {
        ...current,
        sessionKey: next.sessionKey,
        status: next.status,
        messages: next.messages,
        streamingText: next.streamingText,
        totalCost: next.totalCost,
        turns: next.turns,
        error: next.error,
      };

      // Clear wait state when the session resumes (auto-continue fired).
      if (
        current.status !== "running" &&
        next.status === "running" &&
        current.waitUntil
      ) {
        merged = { ...merged, waitUntil: null, waitReason: null };
      }

      emitUpdate(merged);
    },
    [emitUpdate],
  );

  useSessionStream({
    ...(socketSubscribe ? { socketSubscribe } : {}),
    state: extractLeaderCore(data),
    onChange: applyCoreUpdate,
    prefix: "lm",
  });

  // ── Node-specific subscription (layered ON TOP of the hook) ───────
  //
  // Declared AFTER `useSessionStream` so it subscribes second and fires
  // second on each message — by the time this runs, `dataRef.current`
  // already reflects the hook's update from the same dispatch.
  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as ServerMessage;
      const current = dataRef.current;

      // Handle sync_response — rebuild or reset state after reconnect
      if (
        serverMsg.type === "sync_response" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        if (serverMsg.found && serverMsg.events) {
          // Replay buffered events to rebuild messages, cost, turns
          const rebuiltMessages: LeaderMessage[] = [];
          let rebuiltCost = serverMsg.totalCost ?? current.totalCost;
          let rebuiltTurns = serverMsg.turns ?? current.turns;
          let rebuiltStatus: LeaderData["status"] =
            (serverMsg.status as LeaderData["status"]) ?? current.status;

          const seenIds = new Set<string>();
          for (const evt of serverMsg.events) {
            if (evt.type === "sdk_event" && evt.message) {
              const lms = sdkToLeaderMessages(evt.message);
              // When a result arrives, drop the last assistant msg if its
              // content matches — avoids duplicate bubble on sync rebuild.
              if (evt.message.type === "result") {
                const resultText = lms.find((m) => m.role === "result")?.content;
                if (resultText) {
                  const lastIdx = rebuiltMessages.findLastIndex((m) => m.role === "assistant");
                  if (lastIdx >= 0 && rebuiltMessages[lastIdx].content.trim() === resultText.trim()) {
                    rebuiltMessages.splice(lastIdx, 1);
                  }
                }
              }
              for (const lm of lms) {
                if (!seenIds.has(lm.id)) {
                  seenIds.add(lm.id);
                  rebuiltMessages.push(lm);
                }
              }
              if (evt.message.type === "result") {
                rebuiltCost = evt.message.total_cost_usd ?? rebuiltCost;
                rebuiltTurns = evt.message.num_turns ?? rebuiltTurns;
              }
            } else if (evt.type === "session_status") {
              rebuiltStatus = (evt.status as LeaderData["status"]) ?? rebuiltStatus;
            }
          }

          const syncData: Partial<LeaderData> = {
            status: rebuiltStatus,
            messages: rebuiltMessages.length > 0 ? rebuiltMessages : current.messages,
            totalCost: rebuiltCost,
            turns: rebuiltTurns,
            streamingText: "",
            error: serverMsg.lastError ?? null,
          };

          // Restore worktree info from sync if available
          if ((serverMsg as Record<string, unknown>).worktree) {
            const wt = (serverMsg as Record<string, unknown>).worktree as { path: string; branch: string };
            syncData.worktreePath = wt.path;
            syncData.worktreeBranch = wt.branch;
            syncData.worktreeStatus = "active";
          }

          // Restore taskName from sync if available
          if (serverMsg.taskName) {
            syncData.taskName = serverMsg.taskName;
          }

          // Restore approval state from sync if available
          const syncApproval = (serverMsg as Record<string, unknown>).approval as {
            requested?: boolean;
            summary?: string;
            diff?: LeaderData["approvalDiff"];
          } | null | undefined;
          if (rebuiltStatus === "completed") {
            // Session is done — force-clear all transient state
            syncData.approvalPending = false;
            syncData.approvalSummary = null;
            syncData.approvalDiff = null;
            syncData.mergeConflict = null;
            syncData.worktreePath = null;
            syncData.worktreeBranch = null;
            syncData.worktreeStatus = "merged";
            syncData.mergeConfirmed = true;
          } else if (syncApproval?.requested) {
            syncData.approvalPending = true;
            syncData.approvalSummary = syncApproval.summary ?? null;
            syncData.approvalDiff = syncApproval.diff ?? null;
          } else {
            syncData.approvalPending = false;
          }

          emitUpdate({
            ...current,
            ...syncData,
          });
        } else if (!serverMsg.found) {
          // Session no longer exists on server — reset to disconnected
          emitUpdate({
            ...current,
            status: "disconnected",
            sessionKey: null,
            streamingText: "",
            error: null,
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
        if (
          serverMsg.message.type === "result" &&
          current.status !== "idle"
        ) {
          emitUpdate({ ...dataRef.current, status: "idle" });
        }
        return;
      }

      // sync_response found: restore worktree/taskName/approval fields
      // that the shared reducer doesn't know about.
      if (
        serverMsg.type === "sync_response" &&
        serverMsg.sessionKey === current.sessionKey &&
        serverMsg.found
      ) {
        const syncData: Partial<LeaderData> = {};
        const raw = serverMsg as Record<string, unknown>;

        if (raw.worktree) {
          const wt = raw.worktree as { path: string; branch: string };
          syncData.worktreePath = wt.path;
          syncData.worktreeBranch = wt.branch;
          syncData.worktreeStatus = "active";
        }
        if (serverMsg.taskName) {
          syncData.taskName = serverMsg.taskName;
        }
        const syncApproval = raw.approval as
          | {
              requested?: boolean;
              summary?: string;
              diff?: LeaderData["approvalDiff"];
            }
          | null
          | undefined;
        if (syncApproval?.requested) {
          syncData.approvalPending = true;
          syncData.approvalSummary = syncApproval.summary ?? null;
          syncData.approvalDiff = syncApproval.diff ?? null;
        } else {
          syncData.approvalPending = false;
        }

        if (Object.keys(syncData).length > 0) {
          emitUpdate({ ...current, ...syncData });
        }
        return;
      }

      // session_task_name — agent set its display name
      if (
        serverMsg.type === "session_task_name" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({ ...current, taskName: serverMsg.taskName });
        return;
      }

      // wait_state — leader is waiting or wait completed/cancelled
      if (
        serverMsg.type === "wait_state" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        if (serverMsg.action === "started") {
          emitUpdate({
            ...current,
            waitUntil:
              (serverMsg.scheduledAt as number) +
              (serverMsg.durationMs as number),
            waitReason: serverMsg.reason as string,
          });
        } else {
          // completed or cancelled — clear wait state
          emitUpdate({ ...current, waitUntil: null, waitReason: null });
        }
        return;
      }

      // worktree_created
      if (
        serverMsg.type === "worktree_created" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreePath: serverMsg.worktreePath as string,
          worktreeBranch: serverMsg.branch as string,
          worktreeStatus: "active",
        });
        return;
      }

      // worktree_failed — isolation was requested but creation failed
      if (
        serverMsg.type === "worktree_failed" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreeStatus: "failed",
          worktreeIsolation: false,
          error: (serverMsg.error as string) ?? "Worktree creation failed",
        });
        return;
      }

      // worktree_merged — merge succeeded and worktree was cleaned up
      if (
        serverMsg.type === "worktree_merged" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreePath: null,
          worktreeBranch: null,
          worktreeStatus: "merged",
          mergeConflict: null,
          mergeConfirmed: true,
          // Clear approval state inline — don't rely on approval_resolved
          // arriving separately, as React batching may cause stale spreads.
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
        });
        return;
      }

      // worktree_merge_failed — conflicts, worktree still active
      if (
        serverMsg.type === "worktree_merge_failed" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        const result = serverMsg.result as
          | { conflicts?: string[]; summary?: string; targetBranch?: string }
          | undefined;
        emitUpdate({
          ...current,
          worktreeStatus: "active",
          approvalPending: true,
          mergeConflict: {
            conflicts: result?.conflicts ?? [],
            summary: result?.summary ?? "Merge conflicts detected",
            targetBranch: result?.targetBranch ?? "main",
          },
          error: null,
        });
        return;
      }

      // worktree_removed (explicit discard)
      if (
        serverMsg.type === "worktree_removed" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          worktreePath: null,
          worktreeBranch: null,
          worktreeStatus: "discarded",
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
        });
        return;
      }

      // approval_requested — leader is waiting for user to approve
      if (
        serverMsg.type === "approval_requested" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          approvalPending: true,
          approvalSummary: (serverMsg.summary as string) ?? null,
          approvalDiff:
            (serverMsg.diff as LeaderData["approvalDiff"]) ?? null,
        });
        return;
      }

      // approval_resolved — approval was accepted or changes requested
      if (
        serverMsg.type === "approval_resolved" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
          // If approved, the worktree_merged event handles worktree status.
        });
        return;
      }

      // Handle session_completed — session lifecycle is done (e.g. after merge)
      if (serverMsg.type === "session_completed" && serverMsg.sessionKey === current.sessionKey) {
        emitUpdate({
          ...current,
          status: "completed",
          // Ensure ALL transient state is cleared — don't rely on prior
          // events having propagated due to React batching / event ordering.
          approvalPending: false,
          approvalSummary: null,
          approvalDiff: null,
          mergeConflict: null,
          waitUntil: null,
          waitReason: null,
          error: null,
        });
        return;
      }
    });
  }, [socketSubscribe, emitUpdate, processSdkEvent]);

  const handleCreate = useCallback(() => {
    if (!socketSend) return;
    const key = `leader-${Date.now().toString(36)}`;
    const userPrompt =
      input.trim() || "Analyze the project and suggest how to proceed.";

    // ── Build previous-session context for restarts ──────────
    // If there are existing messages from a prior session, this is a restart.
    // Serialize conversation + task plan so the new Claude instance has continuity.
    const prevMessages = dataRef.current.messages;
    const prevTaskPlan = dataRef.current.taskPlan ?? [];
    const prevTaskName = dataRef.current.taskName;
    const sessionContext = buildSessionContext(prevMessages, prevTaskPlan, prevTaskName);

    // Gather context from connected nodes
    const contextItems = getContextForNode?.() ?? [];
    let fullPrompt = userPrompt;

    if (contextItems.length > 0) {
      const contextBlock = contextItems
        .map((item) => {
          const isDefault = item.label.toLowerCase() === item.nodeType.toLowerCase();
          const openTag = isDefault
            ? `<context-group>`
            : `<context-group title="${item.label}">`;
          return `${openTag}\n${item.content}\n</context-group>`;
        })
        .join("\n");
      fullPrompt = `<connected-context>\nThe following context has been provided by the user via connected canvas nodes:\n\n${contextBlock}\n</connected-context>\n\n${userPrompt}`;
    }

    // Prepend previous session context if this is a restart
    if (sessionContext) {
      fullPrompt = `${sessionContext}\n\n${fullPrompt}`;
    }

    // Compile tagged skills into system prompt addendum
    const taggedSkills = (data.skillIds ?? [])
      .map((id) => getSkill(id))
      .filter((s): s is SkillTemplate => s !== undefined);
    const skillsAddendum = compileSkills(taggedSkills, data.skillValues ?? {});
    const finalSystemPrompt = LEADER_SYSTEM_PROMPT + skillsAddendum;

    socketSend({
      type: "create_session",
      sessionKey: key,
      prompt: fullPrompt,
      systemPrompt: finalSystemPrompt,
      role: "leader",
      model: data.model,
      thinkingConfig: data.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      worktreeIsolation: data.worktreeIsolation,
      ...(projectPath ? { cwd: projectPath } : {}),
    });
    syncedRef.current = true;
    onUpdateData({
      ...dataRef.current,
      sessionKey: key,
      status: "creating",
      messages: [
        ...prevMessages,
        {
          id: msgId(),
          role: "user" as const,
          content: userPrompt,
          timestamp: Date.now(),
        },
      ],
    });
    setInput("");
  }, [socketSend, input, onUpdateData, getContextForNode, data.skillIds, data.skillValues, data.model, data.thinkingConfig]);

  // Auto-start session when autoStartPrompt is set (e.g. from Kanban launch)
  const autoStartFired = useRef(false);
  useEffect(() => {
    if (autoStartFired.current) return;
    const prompt = dataRef.current.autoStartPrompt;
    if (!prompt || dataRef.current.sessionKey || !socketSend) return;
    autoStartFired.current = true;

    const key = `leader-${Date.now().toString(36)}`;

    // ── Build previous-session context for restarts ──────────
    const prevMessages = dataRef.current.messages;
    const prevTaskPlan = dataRef.current.taskPlan ?? [];
    const prevTaskName = dataRef.current.taskName;
    const sessionContext = buildSessionContext(prevMessages, prevTaskPlan, prevTaskName);

    // Gather context from connected nodes
    const contextItems = getContextForNode?.() ?? [];
    let fullPrompt = prompt;
    if (contextItems.length > 0) {
      const contextBlock = contextItems
        .map((item) => {
          const isDefault = item.label.toLowerCase() === item.nodeType.toLowerCase();
          const openTag = isDefault
            ? `<context-group>`
            : `<context-group title="${item.label}">`;
          return `${openTag}\n${item.content}\n</context-group>`;
        })
        .join("\n");
      fullPrompt = `<connected-context>\nThe following context has been provided by the user via connected canvas nodes:\n\n${contextBlock}\n</connected-context>\n\n${prompt}`;
    }

    // Prepend previous session context if this is a restart
    if (sessionContext) {
      fullPrompt = `${sessionContext}\n\n${fullPrompt}`;
    }

    // Compile tagged skills
    const taggedSkills = (dataRef.current.skillIds ?? [])
      .map((id) => getSkill(id))
      .filter((s): s is SkillTemplate => s !== undefined);
    const skillsAddendum = compileSkills(taggedSkills, dataRef.current.skillValues ?? {});
    const finalSystemPrompt = LEADER_SYSTEM_PROMPT + skillsAddendum;

    socketSend({
      type: "create_session",
      sessionKey: key,
      prompt: fullPrompt,
      systemPrompt: finalSystemPrompt,
      role: "leader",
      model: dataRef.current.model,
      thinkingConfig: dataRef.current.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      worktreeIsolation: dataRef.current.worktreeIsolation,
      ...(projectPath ? { cwd: projectPath } : {}),
    });
    syncedRef.current = true;
    onUpdateData({
      ...dataRef.current,
      sessionKey: key,
      status: "creating",
      autoStartPrompt: null, // Clear so it doesn't re-trigger
      messages: [
        ...prevMessages,
        {
          id: msgId(),
          role: "user" as const,
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    });
  }, [socketSend, onUpdateData, getContextForNode, projectPath]);

  const handleSend = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !input.trim() || !current.sessionKey) return;

    // Compile current skills into system prompt so mid-session skill
    // additions/removals take effect on the next turn
    const taggedSkills = (current.skillIds ?? [])
      .map((id) => getSkill(id))
      .filter((s): s is SkillTemplate => s !== undefined);
    const skillsAddendum = compileSkills(taggedSkills, current.skillValues ?? {});
    const finalSystemPrompt = LEADER_SYSTEM_PROMPT + skillsAddendum;

    socketSend({
      type: "send_message",
      sessionKey: current.sessionKey,
      prompt: input.trim(),
      systemPrompt: finalSystemPrompt,
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
    socketSend({ type: "interrupt_session", sessionKey: current.sessionKey });
  }, [socketSend]);

  const handleModelChange = useCallback(
    (model: ModelOption) => {
      const current = dataRef.current;
      onUpdateData({ ...current, model });
      if (socketSend && current.sessionKey) {
        socketSend({ type: "set_model", sessionKey: current.sessionKey, model });
      }
    },
    [socketSend, onUpdateData],
  );

  const handlePermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      const current = dataRef.current;
      onUpdateData({ ...current, permissionMode: mode });
      if (socketSend && current.sessionKey) {
        socketSend({ type: "set_permission_mode", sessionKey: current.sessionKey, permissionMode: mode });
      }
    },
    [socketSend, onUpdateData],
  );

  // Thinking config takes effect on the *next* turn — every turn re-creates
  // the SDK query() with fresh options. We don't push a runtime command;
  // the server reads the latest config from each send_message payload.
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
    },
    [handleSend, handleCreate],
  );


  // P6: Reset session handler
  const handleReset = useCallback(() => {
    if (!confirm("Reset this Leader session? All messages will be cleared.")) return;
    if (socketSend && data.sessionKey) {
      socketSend({ type: "stop_session", sessionKey: data.sessionKey });
    }
    syncedRef.current = false;
    emitUpdate({
      ...LEADER_DEFAULT_DATA,
      skillIds: data.skillIds,
      skillValues: data.skillValues,
      model: data.model,
      permissionMode: data.permissionMode,
      thinkingConfig: data.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      worktreeIsolation: data.worktreeIsolation,
    });
  }, [socketSend, data, emitUpdate]);

  // New Session handler — preserves conversation context for continuity.
  // If the user has typed a prompt in the input, it becomes the autoStartPrompt
  // for the new session so they don't have to click "Start" again.
  const handleNewSession = useCallback(() => {
    const current = dataRef.current;
    const pendingPrompt = input.trim() || null;
    // Stop the old session on the server if it's still tracked
    if (socketSend && current.sessionKey) {
      socketSend({ type: "stop_session", sessionKey: current.sessionKey });
    }
    // Reset to default state but keep messages + taskPlan so buildSessionContext
    // can inject them as <previous-session-context> on the next handleCreate().
    // Also preserve user preferences (model, skills, permissions, isolation).
    syncedRef.current = false;
    emitUpdate({
      ...LEADER_DEFAULT_DATA,
      messages: current.messages,
      taskPlan: current.taskPlan,
      taskName: current.taskName,
      skillIds: current.skillIds,
      skillValues: current.skillValues,
      model: current.model,
      permissionMode: current.permissionMode,
      worktreeIsolation: false, // worktree isolation off by default
      ...(pendingPrompt ? { autoStartPrompt: pendingPrompt } : {}),
    });
    setInput("");
  }, [socketSend, emitUpdate, input]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (dataRef.current.status === "completed") {
          handleNewSession();
        } else if (dataRef.current.sessionKey) {
          handleSend();
        } else {
          handleCreate();
        }
      }
    },
    [handleSend, handleCreate, handleNewSession],
  );

  // P6: Export log handler
  const handleExportLog = useCallback(() => {
    const lines = data.messages.map((m) => {
      const ts = new Date(m.timestamp).toISOString();
      return `[${ts}] [${m.role}] ${m.content}${m.suffix ? ` (${m.suffix})` : ""}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leader-log-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data.messages]);

  const statusColor: Record<string, string> = {
    disconnected: "var(--text-muted)",
    creating: "var(--status-creating)",
    running: "var(--success-color)",
    idle: "var(--status-idle)",
    stopped: "var(--status-error)",
    error: "var(--danger-color)",
    completed: "var(--success-color)",
  };

  const taggedSkillCount = (data.skillIds ?? []).length;

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
        position: "relative",
      }}
    >
      {/* P1: Resize handle */}
      {onResize && (
        <ResizeHandle
          currentSize={node.size}
          minWidth={420}
          minHeight={320}
          onResize={onResize}
          color="var(--accent)"
          canvasScale={canvasScale}
        />
      )}

      {/* Header — P6: enhanced with menu, turn count, skill badges */}
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
          background: "linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-secondary) 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <img
            src={
              data.status === "running" || data.status === "creating"
                ? "/icons/leader-active.svg"
                : "/icons/leader-idle.svg"
            }
            alt={data.status === "running" || data.status === "creating" ? "Active" : "Idle"}
            width={20}
            height={20}
            className="leader-status-icon"
            style={{ display: "block", flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-primary)",
                fontWeight: 600,
                lineHeight: 1.2,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <EditableTitle
                value={data.taskName ?? "Leader"}
                onChange={(name) => onUpdateData({ ...data, taskName: name || null })}
              />
              {/* Skill badge icons in header */}
              {taggedSkillCount > 0 && (
                <span
                  onClick={() => setSkillFlyoutOpen(true)}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                    padding: "1px 5px",
                    borderRadius: 3,
                    fontSize: 9,
                    fontFamily: "var(--font-mono)",
                    background: "var(--state-active)",
                    color: "var(--accent)",
                    cursor: "pointer",
                  }}
                  title="Skills configured"
                >
                  ⚡{taggedSkillCount}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 9,
                color: statusColor[data.status] ?? "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {data.status}
              {/* Turn count badge */}
              {data.turns > 0 && (
                <span style={{ color: "var(--text-muted)", textTransform: "none" }}>
                  {data.turns} turn{data.turns !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
          {/* P6: Header menu */}
          <HeaderMenu
            onReset={handleReset}
            onExportLog={handleExportLog}
            data={data}
            canvasScale={canvasScale}
          />
        </div>
      </div>

      {/* Session control toolbar */}
      <SessionToolbar
        sessionKey={data.sessionKey}
        status={data.status}
        model={data.model ?? "opus"}
        permissionMode={data.permissionMode ?? "auto"}
        onInterrupt={handleInterrupt}
        onModelChange={handleModelChange}
        onPermissionModeChange={handlePermissionModeChange}
        thinkingConfig={data.thinkingConfig ?? DEFAULT_THINKING_CONFIG}
        onThinkingConfigChange={handleThinkingConfigChange}
        accent="var(--accent)"
        skillsContent={
          <div
            ref={skillAnchorRef}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <button
              onClick={() => setSkillFlyoutOpen(true)}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 10px",
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                background: taggedSkillCount > 0 ? "var(--state-active)" : "var(--bg-elevated)",
                border: taggedSkillCount > 0 ? "1px solid var(--accent)" : "1px dashed var(--border-default)",
                color: taggedSkillCount > 0 ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              ⚡ Skills {taggedSkillCount > 0 ? `(${taggedSkillCount})` : ""}
            </button>
            {/* Show active skill chips inline */}
            {(data.skillIds ?? [])
              .map((id) => getSkill(id))
              .filter((s): s is SkillTemplate => s !== undefined)
              .slice(0, 3)
              .map((skill) => (
                <SkillTagChip key={skill.id} skill={skill} readOnly={false} onRemove={() => {
                  const next = (data.skillIds ?? []).filter((s) => s !== skill.id);
                  const nextValues = { ...(data.skillValues ?? {}) };
                  delete nextValues[skill.id];
                  onUpdateData({ ...dataRef.current, skillIds: next, skillValues: nextValues });
                }} />
              ))}
            {taggedSkillCount > 3 && (
              <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                +{taggedSkillCount - 3} more
              </span>
            )}
          </div>
        }
      />

      {/* Status banners */}
      <StatusBannerStack banners={banners} onDismiss={dismissBanner} />

      {/* P3: Skill Flyout */}
      <SkillFlyout
        skillIds={data.skillIds ?? []}
        skillValues={data.skillValues ?? {}}
        open={skillFlyoutOpen}
        readOnly={false}
        anchorRef={skillAnchorRef}
        onUpdate={(patch) => {
          onUpdateData({ ...dataRef.current, ...patch });
        }}
        onClose={() => setSkillFlyoutOpen(false)}
      />

      {/* P4: Task Plan Panel */}
      <TaskPlanPanel
        taskPlan={data.taskPlan ?? []}
        expanded={tasksExpanded}
        onToggle={() => setTasksExpanded((p) => !p)}
        onRevealMinion={onRevealMinion}
      />

      {/* Scroll-capture zone: hover or click to capture scroll, click outside to release */}
      <div
        ref={scrollZoneRef}
        data-scroll-capture
        onPointerDown={() => setScrollLocked(true)}
        className={`leader-scroll-zone${scrollLocked ? " leader-scroll-zone--locked" : ""}`}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
      {/* Messages — P5: with markdown rendering and collapsible user messages */}
      <div
        ref={outputRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
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
              ? "Leader is thinking..."
              : "Describe your project goal to begin orchestration"}
          </div>
        )}
        {groupMessages(data.messages).map((group, gi) => {
          if (group.kind === "tool-group") {
            return <LeaderToolGroup key={`tg-${gi}`} msgs={group.msgs} />;
          }
          if (group.kind === "thinking-group") {
            return (
              <LeaderThinkingGroup
                key={`thg-${gi}`}
                msgs={group.msgs}
                effort={data.thinkingConfig?.effort}
              />
            );
          }
          const msg = group.msg;

          // P5: User messages get collapsible treatment
          if (msg.role === "user") {
            return <UserMessageBubble key={msg.id} msg={msg} />;
          }

          // Thinking messages (singleton — rare, usually grouped)
          if (msg.role === "thinking") {
            return (
              <LeaderThinkingGroup
                key={msg.id}
                msgs={[msg]}
                effort={data.thinkingConfig?.effort}
              />
            );
          }

          // P5: Assistant messages get markdown rendering
          if (msg.role === "assistant") {
            return (
              <div
                key={msg.id}
                className="copyable"
                style={{
                  position: "relative",
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.6,
                  fontFamily: "var(--font-sans)",
                  color: "var(--text-primary)",
                  borderLeft: "2px solid var(--accent)",
                  wordBreak: "break-word",
                  overflowWrap: "break-word",
                }}
              >
                <CopyButton text={msg.content} />
                <AddAsNodeButton text={msg.content} onAdd={onAddContentNode} />
                <SimpleMarkdown text={msg.content} />
                {msg.suffix && (
                  <span style={{ display: "inline-block", marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", opacity: 0.7 }}>
                    {msg.suffix}
                  </span>
                )}
              </div>
            );
          }

          // P5: Result messages get markdown too
          if (msg.role === "result") {
            return (
              <div
                key={msg.id}
                className="copyable"
                style={{
                  position: "relative",
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: 1.6,
                  fontFamily: "var(--font-sans)",
                  color: "var(--text-primary)",
                  borderLeft: "2px solid var(--success-color)",
                  wordBreak: "break-word",
                  overflowWrap: "break-word",
                }}
              >
                <CopyButton text={msg.content} />
                <AddAsNodeButton text={msg.content} onAdd={onAddContentNode} />
                <SimpleMarkdown text={msg.content} />
                {msg.suffix && (
                  <span style={{ display: "inline-block", marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", opacity: 0.7 }}>
                    {msg.suffix}
                  </span>
                )}
              </div>
            );
          }

          // System messages — compact
          return (
            <div
              key={msg.id}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                fontSize: 10,
                lineHeight: 1.6,
                fontFamily: "var(--font-sans)",
                color: "var(--text-primary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflowWrap: "break-word",
                opacity: 0.5,
              }}
            >
              {msg.content}
              {msg.suffix && (
                <span style={{ display: "inline-block", marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", opacity: 0.7 }}>
                  {msg.suffix}
                </span>
              )}
            </div>
          );
        })}
        {/* Streaming partial text with blinking cursor */}
        {data.streamingText ? (
          <StreamingBubble text={data.streamingText.replace(/<!--task-name:.+?-->\s*/g, "")} borderColor="var(--accent)" />
        ) : data.status === "running" && data.messages.length > 0 ? (
          <StreamingIndicator label="Leader is thinking..." />
        ) : null}
        {/* Wait countdown timer */}
        {data.waitUntil && data.waitUntil > Date.now() && (
          <WaitCountdown waitUntil={data.waitUntil} reason={data.waitReason ?? "Waiting..."} />
        )}
      </div>

      {/* P4: Unified config footer (worktree + context) */}
      <ConfigFooter
        data={data}
        onUpdateData={(d) => emitUpdate(d)}
        socketSend={socketSend}
        getContextForNode={getContextForNode}
      />

      {/* P2: Auto-growing input */}
      <div
        style={{
          padding: "8px 10px",
          borderTop: "1px solid var(--border-default)",
          display: "flex",
          gap: 6,
          flexShrink: 0,
          background: "var(--bg-secondary)",
          alignItems: "flex-end",
        }}
      >
        <AutoTextarea
          value={input}
          onChange={setInput}
          onKeyDown={handleKeyDown}
          placeholder={
            data.status === "completed"
              ? "Describe next goal (context preserved)..."
              : data.sessionKey
                ? "Guide the leader..."
                : "Describe your project goal..."
          }
          maxRows={8}
        />
        <button
          onClick={
            data.status === "completed"
              ? () => { handleNewSession(); }
              : data.sessionKey ? handleSend : handleCreate
          }
          onMouseDown={(e) => e.stopPropagation()}
          disabled={!input.trim() && !!data.sessionKey && data.status !== "completed"}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background:
              data.status === "completed"
                ? "var(--gradient-primary)"
                : input.trim() || !data.sessionKey
                  ? "var(--gradient-primary)"
                  : "var(--bg-elevated)",
            color:
              data.status === "completed"
                ? "var(--text-primary)"
                : input.trim() || !data.sessionKey
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
            opacity: !input.trim() && !!data.sessionKey && data.status !== "completed" ? 0.4 : 1,
            marginBottom: 1,
          }}
        >
          {data.status === "completed" ? "New Session" : data.sessionKey ? "Send" : "Start"}
        </button>
      </div>
      </div>{/* end scroll-capture zone */}

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
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{data.error}</span>
          <button
            onClick={() => onUpdateData({ ...data, error: null })}
            style={{
              background: "none",
              border: "none",
              color: "var(--status-error)",
              cursor: "pointer",
              fontSize: 13,
              padding: "0 2px",
              lineHeight: 1,
              flexShrink: 0,
              opacity: 0.7,
            }}
            title="Dismiss error"
          >
            x
          </button>
        </div>
      )}
    </div>
  );
}

registerNodeType({
  type: "leader",
  label: "Leader",
  defaultSize: { width: 560, height: 520 },
  render: LeaderNodeRenderer,
});

export const LEADER_DEFAULT_DATA: LeaderData = {
  sessionKey: null,
  status: "disconnected",
  messages: [],
  streamingText: "",
  totalCost: 0,
  turns: 0,
  error: null,
  model: "opus",
  permissionMode: "auto",
  thinkingConfig: { ...DEFAULT_THINKING_CONFIG },
  taskPlan: [],
  worktreeIsolation: false,
  worktreePath: null,
  worktreeBranch: null,
  worktreeStatus: "none",
  skillIds: [],
  skillValues: {},
  skillPanelOpen: false,
  waitUntil: null,
  waitReason: null,
};
