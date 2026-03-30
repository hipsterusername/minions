import { useState, useEffect, useRef, useCallback } from "react";
import type { NodeRenderProps } from "../types.ts";
import { registerNodeType } from "../node-registry.ts";
import { registerContract, LEADER_CONTRACT } from "../graph.ts";
import type { ServerMessage, SdkMessage, ContentBlock } from "../use-socket.ts";
import { LEADER_SYSTEM_PROMPT } from "../prompts/leader-system.ts";
import { useStatusBanners, StatusBannerStack } from "../components/StatusBanner.tsx";
import { StreamingBubble, StreamingIndicator } from "../components/StreamingBubble.tsx";
import { extractStreamDelta, isStreamingEvent, isStreamEnd } from "../streaming.ts";
import { SessionToolbar } from "../components/SessionToolbar.tsx";
import type { ModelOption, PermissionMode } from "../components/SessionToolbar.tsx";
import { getSkill, getAllSkills } from "../skills/registry.ts";
import { compileSkills } from "../skills/types.ts";
import type { SkillTemplate } from "../skills/types.ts";

registerContract(LEADER_CONTRACT);

export interface CompletedTask {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  result: string | null;
  completedAt: number;
  cost: number;
  sessionKey: string | null;
  /** Full minion session messages for tooltip detail */
  sessionSummary: string;
}

export interface LeaderData {
  sessionKey: string | null;
  status: "disconnected" | "creating" | "running" | "idle" | "stopped" | "error";
  messages: LeaderMessage[];
  /** Accumulated partial text from streaming deltas */
  streamingText: string;
  totalCost: number;
  turns: number;
  error: string | null;
  model: ModelOption;
  permissionMode: PermissionMode;
  completedTasks: CompletedTask[];
  worktreeIsolation: boolean;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeStatus: "none" | "creating" | "active" | "merging" | "merged" | "discarded";
  /** IDs of skills tagged onto this leader */
  skillIds: string[];
  /** Variable values for each skill: { [skillId]: { [varName]: value } } */
  skillValues: Record<string, Record<string, string>>;
  /** Whether the skill config panel is expanded */
  skillPanelOpen: boolean;
}

interface LeaderMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "result";
  content: string;
  timestamp: number;
  toolName?: string;
  /** e.g. "8.6s · $0.0288" */
  suffix?: string;
}

interface PlanItem {
  title: string;
  status: "pending" | "active" | "completed" | "failed";
}

/** Extract numbered/bulleted plan items from assistant text */
function extractPlanItems(text: string): PlanItem[] {
  const lines = text.split("\n");
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^\s*(?:\d+[.)]\s+|[-*•]\s+|Task:\s+)(.+)/i);
    if (match) {
      const title = match[1].trim().replace(/\*\*/g, "");
      if (title.length > 3 && title.length < 200 && !seen.has(title.toLowerCase())) {
        seen.add(title.toLowerCase());
        items.push({ title, status: "pending" });
      }
    }
  }
  return items;
}

function msgId(): string {
  return `lm-${crypto.randomUUID()}`;
}

function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      parts.push(`[Tool: ${block.name}]`);
    }
  }
  return parts.join("\n").replace(/<!--task-name:.+?-->\s*/g, "");
}

function sdkToLeaderMessage(sdkMsg: SdkMessage): LeaderMessage | null {
  const now = Date.now();
  switch (sdkMsg.type) {
    case "system": {
      const sub = sdkMsg.subtype;
      if (sub === "init") {
        const model = sdkMsg.model ?? "unknown";
        return { id: msgId(), role: "system", content: `Leader on ${model}`, timestamp: now };
      }
      if (sub === "task_started") {
        return { id: msgId(), role: "system", content: `Subagent: ${sdkMsg.description ?? sdkMsg.task_id ?? "task"}`, timestamp: now };
      }
      if (sub === "task_notification") {
        const ico = sdkMsg.status === "completed" ? "\u2713" : "\u2717";
        return { id: msgId(), role: "system", content: `${ico} Subagent ${sdkMsg.status}: ${sdkMsg.summary ?? ""}`, timestamp: now };
      }
      if (sub === "local_command_output" && sdkMsg.content) {
        return { id: msgId(), role: "system", content: sdkMsg.content, timestamp: now };
      }
      return null;
    }
    case "assistant":
      if (sdkMsg.message?.content) {
        const text = extractText(sdkMsg.message.content);
        if (!text.trim()) return null;
        return { id: msgId(), role: "assistant", content: text, timestamp: now };
      }
      return null;
    case "tool_progress":
      return {
        id: msgId(), role: "tool",
        content: `${sdkMsg.tool_name} (${sdkMsg.elapsed_time_seconds?.toFixed(1)}s)`,
        timestamp: now, toolName: sdkMsg.tool_name,
      };
    case "tool_use_summary":
      if (sdkMsg.summary) {
        return { id: msgId(), role: "system", content: sdkMsg.summary, timestamp: now };
      }
      return null;
    case "result": {
      const txt = sdkMsg.result ?? (sdkMsg.is_error ? "Error" : "Done");
      const ds = sdkMsg.duration_ms ? `${(sdkMsg.duration_ms / 1000).toFixed(1)}s` : null;
      const cs = sdkMsg.total_cost_usd ? `$${sdkMsg.total_cost_usd.toFixed(4)}` : null;
      const sfx = [ds, cs].filter(Boolean).join(" · ");
      return { id: msgId(), role: "result", content: txt, timestamp: now, suffix: sfx || undefined };
    }
    default:
      return null;
  }
}

/* ── Tool group helpers (Leader purple theme) ────────────────────────── */

type LeaderMessageGroup =
  | { kind: "single"; msg: LeaderMessage }
  | { kind: "tool-group"; msgs: LeaderMessage[] };

function groupMessages(messages: LeaderMessage[]): LeaderMessageGroup[] {
  const groups: LeaderMessageGroup[] = [];
  let toolBatch: LeaderMessage[] = [];

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
          background: expanded ? "rgba(129, 140, 248, 0.08)" : "transparent",
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
            background: "rgba(129, 140, 248, 0.10)",
            color: "#818cf8",
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
            {msgs.map((m) => {
              const icon = TOOL_ICONS[m.toolName ?? ""] ?? "\u2022";
              return (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-muted)",
                    lineHeight: 1.6,
                  }}
                >
                  <span
                    style={{
                      color: "#818cf8",
                      opacity: 0.5,
                      fontSize: 10,
                      flexShrink: 0,
                      width: 12,
                      textAlign: "center",
                    }}
                  >
                    {icon}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.content}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#facc15",
  low: "#60a5fa",
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

function TaskTracker({ tasks }: { tasks: CompletedTask[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const totalTasks = tasks.length;

  return (
    <div
      style={{
        borderTop: "1px solid var(--border-default)",
        flexShrink: 0,
        background: "var(--bg-secondary)",
      }}
    >
      {/* Header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          padding: "6px 10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>
          Task Tracker ({totalTasks} completed)
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            display: "inline-block",
          }}
        >
          ▼
        </span>
      </div>

      {/* Task list */}
      {!collapsed && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            maxHeight: 180,
            overflowY: "auto",
            padding: "0 10px 6px",
          }}
        >
          {tasks.map((task, idx) => (
            <div
              key={task.taskId}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 6px",
                borderRadius: 4,
                background: hoveredIdx === idx ? "var(--bg-elevated)" : "transparent",
                cursor: "default",
              }}
            >
              <span style={{ color: "#4ade80", fontSize: 12, flexShrink: 0 }}>✓</span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-primary)",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {task.title}
              </span>
              <span
                style={{
                  fontSize: 9,
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: PRIORITY_COLORS[task.priority] ?? "#4a5068",
                  color: "#fff",
                  fontWeight: 600,
                  flexShrink: 0,
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                }}
              >
                {task.priority}
              </span>
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

              {/* Tooltip */}
              {hoveredIdx === idx && (
                <div
                  style={{
                    position: "absolute",
                    bottom: "calc(100% + 6px)",
                    left: 0,
                    zIndex: 9999,
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 8,
                    padding: 12,
                    maxWidth: 360,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    pointerEvents: "none",
                  }}
                >
                  <div style={{ fontSize: 11, color: "var(--text-primary)", marginBottom: 6, lineHeight: 1.4 }}>
                    {task.description.length > 200
                      ? task.description.slice(0, 200) + "…"
                      : task.description}
                  </div>
                  {task.sessionKey && (
                    <div
                      style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-muted)",
                        marginBottom: 4,
                        opacity: 0.7,
                      }}
                    >
                      {task.sessionKey}
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
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Skill tag panel ────────────────────────────────────────────────── */

const SKILL_CATEGORIES: { key: string; label: string }[] = [
  { key: "code", label: "Code" },
  { key: "docs", label: "Docs" },
  { key: "testing", label: "Testing" },
  { key: "devops", label: "DevOps" },
  { key: "analysis", label: "Analysis" },
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
    <div style={{ padding: "4px 0", display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontSize: 9,
          fontFamily: "var(--font-mono)",
          color: skill.accentColor,
          opacity: 0.7,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {skill.name} Variables
      </div>
      {skill.variables.map((v) => (
        <div key={v.name} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label
            style={{
              fontSize: 10,
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {v.label}
            {v.required && (
              <span style={{ color: "#ef4444", fontSize: 9 }}>*</span>
            )}
          </label>
          {v.type === "select" ? (
            <select
              value={values[v.name] ?? v.defaultValue ?? ""}
              onChange={(e) => onChange(v.name, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              disabled={readOnly}
              style={{
                padding: "4px 6px",
                fontSize: 10,
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
                padding: "4px 6px",
                fontSize: 10,
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
                padding: "4px 6px",
                fontSize: 10,
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
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {v.description}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function SkillPanel({
  skillIds,
  skillValues,
  panelOpen,
  readOnly,
  onUpdate,
}: {
  skillIds: string[];
  skillValues: Record<string, Record<string, string>>;
  panelOpen: boolean;
  readOnly: boolean;
  onUpdate: (patch: {
    skillIds?: string[];
    skillValues?: Record<string, Record<string, string>>;
    skillPanelOpen?: boolean;
  }) => void;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const allSkills = getAllSkills();
  const taggedSkills = skillIds
    .map((id) => getSkill(id))
    .filter((s): s is SkillTemplate => s !== undefined);

  const handleAddSkill = (id: string) => {
    if (!skillIds.includes(id)) {
      onUpdate({
        skillIds: [...skillIds, id],
        skillPanelOpen: true,
      });
    }
    setDropdownOpen(false);
  };

  const handleRemoveSkill = (id: string) => {
    const next = skillIds.filter((s) => s !== id);
    const nextValues = { ...skillValues };
    delete nextValues[id];
    onUpdate({ skillIds: next, skillValues: nextValues });
  };

  const handleVarChange = (skillId: string, varName: string, value: string) => {
    const current = skillValues[skillId] ?? {};
    onUpdate({
      skillValues: {
        ...skillValues,
        [skillId]: { ...current, [varName]: value },
      },
    });
  };

  // Group available skills by category for the dropdown
  const availableByCategory = SKILL_CATEGORIES
    .map((cat) => ({
      ...cat,
      skills: allSkills.filter(
        (s) => s.category === cat.key && !skillIds.includes(s.id),
      ),
    }))
    .filter((cat) => cat.skills.length > 0);

  return (
    <div
      style={{
        borderTop: "1px solid var(--border-default)",
        background: "var(--bg-secondary)",
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div
        onClick={() => onUpdate({ skillPanelOpen: !panelOpen })}
        style={{
          padding: "4px 10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
          ⚡ Skills ({taggedSkills.length})
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            transform: panelOpen ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 0.15s",
            display: "inline-block",
          }}
        >
          ▼
        </span>
      </div>

      {/* Expanded content */}
      {panelOpen && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ padding: "0 10px 6px" }}
        >
          {/* Tag chips row */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              alignItems: "center",
              marginBottom: taggedSkills.length > 0 ? 6 : 0,
            }}
          >
            {taggedSkills.map((skill) => (
              <SkillTagChip
                key={skill.id}
                skill={skill}
                readOnly={readOnly}
                onRemove={() => handleRemoveSkill(skill.id)}
              />
            ))}
            {/* Add button */}
            {!readOnly && (
              <div style={{ position: "relative" }}>
                <button
                  onClick={() => setDropdownOpen(!dropdownOpen)}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    background: "var(--bg-elevated)",
                    border: "1px dashed var(--border-default)",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                  }}
                >
                  + Add
                </button>
                {/* Dropdown */}
                {dropdownOpen && availableByCategory.length > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 4px)",
                      left: 0,
                      zIndex: 999,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 6,
                      padding: 4,
                      minWidth: 180,
                      maxHeight: 240,
                      overflowY: "auto",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}
                  >
                    {availableByCategory.map((cat) => (
                      <div key={cat.key}>
                        <div
                          style={{
                            fontSize: 9,
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-muted)",
                            padding: "4px 8px 2px",
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                          }}
                        >
                          {cat.label}
                        </div>
                        {cat.skills.map((skill) => (
                          <button
                            key={skill.id}
                            onClick={() => handleAddSkill(skill.id)}
                            onMouseDown={(e) => e.stopPropagation()}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              width: "100%",
                              padding: "4px 8px",
                              background: "transparent",
                              border: "none",
                              borderRadius: 4,
                              color: "var(--text-primary)",
                              fontSize: 11,
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.background = "var(--bg-surface)")
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.background = "transparent")
                            }
                          >
                            <span>{skill.icon}</span>
                            <span>{skill.name}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {dropdownOpen && availableByCategory.length === 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 4px)",
                      left: 0,
                      zIndex: 999,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 6,
                      padding: "8px 12px",
                      fontSize: 10,
                      color: "var(--text-muted)",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}
                  >
                    All skills already added
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Variable inputs for each tagged skill */}
          {taggedSkills.map((skill) => (
            <SkillVariableInputs
              key={skill.id}
              skill={skill}
              values={skillValues[skill.id] ?? {}}
              onChange={(varName, value) => handleVarChange(skill.id, varName, value)}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Plan decomposition panel ──────────────────────────────────────── */

function PlanPanel({
  items,
  expanded,
  onToggle,
}: {
  items: PlanItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (items.length === 0) return null;

  const completedCount = items.filter((i) => i.status === "completed").length;

  const statusDotColor: Record<PlanItem["status"], string> = {
    pending: "#4a5068",
    active: "#facc15",
    completed: "#4ade80",
    failed: "#ef4444",
  };

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border-default)",
        flexShrink: 0,
      }}
    >
      <div
        onClick={onToggle}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          padding: "8px 12px",
          cursor: "pointer",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          fontFamily: "var(--font-sans)",
          color: "var(--text-primary)",
        }}
      >
        <span style={{ fontSize: 10 }}>{expanded ? "▼" : "▶"}</span>
        <span style={{ fontWeight: 600 }}>Plan</span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ({completedCount}/{items.length})
        </span>
      </div>
      {expanded && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            padding: "0 12px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {items.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                color: item.status === "completed"
                  ? "var(--text-muted)"
                  : "var(--text-primary)",
                lineHeight: 1.4,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: statusDotColor[item.status],
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  textDecoration: item.status === "completed" ? "line-through" : "none",
                  opacity: item.status === "completed" ? 0.6 : 1,
                }}
              >
                {item.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LeaderNodeRenderer({
  node,
  onUpdateData,
  socketSend,
  socketSubscribe,
  getContextForNode,
  projectPath,
}: NodeRenderProps) {
  const data = node.data as LeaderData;
  const dataRef = useRef(data);
  dataRef.current = data;

  const [input, setInput] = useState("");
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [planExpanded, setPlanExpanded] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const syncedRef = useRef(false);
  const planParsedRef = useRef(false);
  const { banners, processSdkEvent, dismissBanner } = useStatusBanners();

  // Parse plan items from first assistant message
  useEffect(() => {
    if (planParsedRef.current) return;
    const firstAssistant = data.messages.find((m) => m.role === "assistant");
    if (!firstAssistant) return;
    const items = extractPlanItems(firstAssistant.content);
    if (items.length > 0) {
      setPlanItems(items);
      setPlanExpanded(true);
      planParsedRef.current = true;
    }
  }, [data.messages]);

  // Update plan item statuses based on completedTasks and system messages
  useEffect(() => {
    if (planItems.length === 0) return;
    const completedTitles = (data.completedTasks ?? []).map((t) => t.title.toLowerCase());
    const systemMsgs = data.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content.toLowerCase());

    setPlanItems((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        const lower = item.title.toLowerCase();
        // Check completed
        if (
          item.status !== "completed" &&
          completedTitles.some((ct) => ct.includes(lower) || lower.includes(ct))
        ) {
          changed = true;
          return { ...item, status: "completed" as const };
        }
        // Check active (subagent started)
        if (
          item.status === "pending" &&
          systemMsgs.some((sm) => sm.includes("subagent") && sm.includes(lower.slice(0, 20)))
        ) {
          changed = true;
          return { ...item, status: "active" as const };
        }
        return item;
      });
      return changed ? next : prev;
    });
  }, [data.completedTasks, data.messages, planItems.length]);

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

          for (const evt of serverMsg.events) {
            if (evt.type === "sdk_event" && evt.message) {
              const lm = sdkToLeaderMessage(evt.message);
              if (lm) rebuiltMessages.push(lm);
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

        // Handle streaming text deltas
        if (isStreamingEvent(serverMsg.message)) {
          const delta = extractStreamDelta(serverMsg.message);
          if (delta !== null) {
            emitUpdate({
              ...current,
              streamingText: (current.streamingText ?? "") + delta,
            });
            return;
          }

          // Stream ended — just clear streaming state
          if (isStreamEnd(serverMsg.message)) {
            return;
          }
          return;
        }

        const lm = sdkToLeaderMessage(serverMsg.message);
        if (lm) {
          const updated = { ...current };
          updated.messages = [...current.messages, lm];
          // Clear streaming buffer on complete assistant message
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
          }
          emitUpdate(updated);
        }
        return;
      }

      if (
        serverMsg.type === "session_status" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          status: serverMsg.status as LeaderData["status"],
        });
        return;
      }

      if (
        serverMsg.type === "session_error" &&
        serverMsg.sessionKey === current.sessionKey
      ) {
        emitUpdate({
          ...current,
          status: "error" as const,
          error: serverMsg.error,
        });
        return;
      }

      // Handle worktree_created
      if (serverMsg.type === "worktree_created" && serverMsg.sessionKey === current.sessionKey) {
        emitUpdate({
          ...current,
          worktreePath: serverMsg.worktreePath as string,
          worktreeBranch: serverMsg.branch as string,
          worktreeStatus: "active",
        });
        return;
      }

      // Handle worktree_merged
      if (serverMsg.type === "worktree_merged" && serverMsg.sessionKey === current.sessionKey) {
        emitUpdate({
          ...current,
          worktreeStatus: "merged",
        });
        return;
      }

      // Handle worktree_removed
      if (serverMsg.type === "worktree_removed" && serverMsg.sessionKey === current.sessionKey) {
        emitUpdate({
          ...current,
          worktreePath: null,
          worktreeBranch: null,
          worktreeStatus: "discarded",
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

    // Gather context from connected nodes
    const contextItems = getContextForNode?.() ?? [];
    let fullPrompt = userPrompt;

    if (contextItems.length > 0) {
      const contextBlock = contextItems
        .map((item) => `## ${item.label} (${item.nodeType})\n\n${item.content}`)
        .join("\n\n---\n\n");
      fullPrompt = `<connected-context>\nThe following context has been provided by the user via connected canvas nodes:\n\n${contextBlock}\n</connected-context>\n\n${userPrompt}`;
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
      worktreeIsolation: data.worktreeIsolation,
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
          content: userPrompt,
          timestamp: Date.now(),
        },
      ],
    });
    setInput("");
  }, [socketSend, input, onUpdateData, getContextForNode, data.skillIds, data.skillValues]);

  const handleSend = useCallback(() => {
    const current = dataRef.current;
    if (!socketSend || !input.trim() || !current.sessionKey) return;
    socketSend({
      type: "send_message",
      sessionKey: current.sessionKey,
      prompt: input.trim(),
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

  const statusColor: Record<string, string> = {
    disconnected: "#4a5068",
    creating: "#facc15",
    running: "#4ade80",
    idle: "#60a5fa",
    stopped: "#f87171",
    error: "#ef4444",
  };

  // Task counts are no longer tracked client-side — task management
  // is handled server-side via MCP tools (assign_task, get_task_status)

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
          background: "linear-gradient(135deg, #1a1040 0%, var(--bg-secondary) 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              background: "linear-gradient(135deg, #818cf8, #6366f1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "#fff",
              fontWeight: 700,
            }}
          >
            L
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-primary)",
                fontWeight: 600,
                lineHeight: 1.2,
              }}
            >
              Leader
              {data.worktreeBranch && (
                <span style={{
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                  color: "#a78bfa",
                  background: "rgba(167, 139, 250, 0.12)",
                  padding: "1px 6px",
                  borderRadius: 3,
                  marginLeft: 4,
                }}>
                  📂 {data.worktreeBranch}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 9,
                color: statusColor[data.status] ?? "#4a5068",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {data.status}
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
                background: "#3a1a1a",
                border: "1px solid #ef4444",
                borderRadius: 4,
                color: "#f87171",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Session control toolbar */}
      <SessionToolbar
        sessionKey={data.sessionKey}
        status={data.status}
        model={data.model ?? "opus"}
        permissionMode={data.permissionMode ?? "bypassPermissions"}
        onInterrupt={handleInterrupt}
        onModelChange={handleModelChange}
        onPermissionModeChange={handlePermissionModeChange}
        accent="#818cf8"
      />

      {/* Status banners */}
      <StatusBannerStack banners={banners} onDismiss={dismissBanner} />

      {/* Skill tags panel */}
      <SkillPanel
        skillIds={data.skillIds ?? []}
        skillValues={data.skillValues ?? {}}
        panelOpen={data.skillPanelOpen ?? false}
        readOnly={!!data.sessionKey}
        onUpdate={(patch) => {
          onUpdateData({ ...dataRef.current, ...patch });
        }}
      />

      {/* Plan decomposition */}
      <PlanPanel
        items={planItems}
        expanded={planExpanded}
        onToggle={() => setPlanExpanded((p) => !p)}
      />

      {/* Messages (simplified — just the recent ones, tools collapsed) */}
      <div
        ref={outputRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          flex: 1,
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
          const msg = group.msg;
          return (
            <div
              key={msg.id}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: msg.role === "system" ? 10 : 12,
                lineHeight: 1.6,
                fontFamily: "var(--font-sans)",
                color:
                  msg.role === "user"
                    ? "var(--accent)"
                    : "var(--text-primary)",
                borderLeft:
                  msg.role === "user"
                    ? "2px solid var(--accent)"
                    : msg.role === "assistant"
                      ? "2px solid #818cf8"
                      : msg.role === "result"
                        ? "2px solid #4ade80"
                        : "none",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflowWrap: "break-word",
                opacity: msg.role === "system" ? 0.5 : 1,
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
          <StreamingBubble text={data.streamingText.replace(/<!--task-name:.+?-->\s*/g, "")} borderColor="#818cf8" />
        ) : data.status === "running" && data.messages.length > 0 ? (
          <StreamingIndicator label="Leader is thinking..." />
        ) : null}
      </div>

      {/* Task Tracker */}
      {data.completedTasks && data.completedTasks.length > 0 && (
        <TaskTracker tasks={data.completedTasks} />
      )}

      {/* Worktree action bar */}
      {data.worktreeStatus === "active" && data.status === "idle" && (
        <div style={{
          padding: "6px 10px",
          borderTop: "1px solid var(--border-default)",
          display: "flex",
          gap: 6,
          alignItems: "center",
          background: "rgba(167, 139, 250, 0.06)",
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", flex: 1, fontFamily: "var(--font-mono)" }}>
            Worktree ready
          </span>
          <button
            onClick={() => {
              if (socketSend && data.sessionKey) {
                socketSend({ type: "get_worktree_diff", sessionKey: data.sessionKey });
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
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
              if (socketSend && data.sessionKey) {
                socketSend({ type: "merge_worktree", sessionKey: data.sessionKey });
                onUpdateData({ ...dataRef.current, worktreeStatus: "merging" });
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              padding: "3px 8px", fontSize: 10, background: "rgba(74, 222, 128, 0.15)",
              border: "1px solid #4ade80", borderRadius: 4,
              color: "#4ade80", cursor: "pointer", fontFamily: "var(--font-mono)",
            }}
          >
            Merge
          </button>
          <button
            onClick={() => {
              if (socketSend && data.sessionKey && confirm("Discard all worktree changes?")) {
                socketSend({ type: "discard_worktree", sessionKey: data.sessionKey });
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              padding: "3px 8px", fontSize: 10, background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid #ef4444", borderRadius: 4,
              color: "#f87171", cursor: "pointer", fontFamily: "var(--font-mono)",
            }}
          >
            Discard
          </button>
        </div>
      )}

      {/* Worktree status indicator */}
      {(data.worktreeStatus === "merging" || data.worktreeStatus === "merged" || data.worktreeStatus === "discarded") && (
        <div style={{
          padding: "4px 10px",
          borderTop: "1px solid var(--border-default)",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: data.worktreeStatus === "merged" ? "#4ade80" : data.worktreeStatus === "discarded" ? "#f87171" : "#facc15",
          background: "var(--bg-secondary)",
          flexShrink: 0,
        }}>
          {data.worktreeStatus === "merging" ? "⏳ Merging..." : data.worktreeStatus === "merged" ? "✅ Merged to main" : "🗑️ Worktree discarded"}
        </div>
      )}

      {/* Context indicator */}
      {getContextForNode && getContextForNode().length > 0 && (
        <div style={{
          padding: "4px 10px",
          borderTop: "1px solid var(--border-default)",
          background: "rgba(129, 140, 248, 0.08)",
          fontSize: 10,
          color: "#818cf8",
          fontFamily: "var(--font-mono)",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}>
          <span>{"\u{1F4CE}"}</span>
          <span>{getContextForNode().length} context source{getContextForNode().length !== 1 ? "s" : ""} connected</span>
        </div>
      )}

      {/* Worktree isolation toggle */}
      <div style={{
        padding: "4px 10px",
        borderTop: "1px solid var(--border-default)",
        background: "var(--bg-secondary)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
      }}>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            if (!data.sessionKey) {
              onUpdateData({ ...data, worktreeIsolation: !data.worktreeIsolation });
            }
          }}
          disabled={!!data.sessionKey}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            padding: "3px 8px",
            borderRadius: 4,
            border: "none",
            cursor: data.sessionKey ? "default" : "pointer",
            opacity: data.sessionKey ? 0.7 : 1,
            background: data.worktreeIsolation
              ? "rgba(99, 102, 241, 0.25)"
              : "rgba(255, 255, 255, 0.06)",
            color: data.worktreeIsolation ? "#818cf8" : "var(--text-muted)",
          }}
        >
          <span>{"\u{1F33F}"}</span>
          <span>Worktree Isolation</span>
          <span style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: data.worktreeIsolation ? "#818cf8" : "var(--text-muted)",
            marginLeft: 2,
          }} />
        </button>
        {data.sessionKey && (
          <span style={{
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}>
            {data.worktreeIsolation ? "isolated" : "shared"}
          </span>
        )}
      </div>

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
              ? "Guide the leader..."
              : "Describe your project goal..."
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
                ? "linear-gradient(135deg, #818cf8, #6366f1)"
                : "var(--bg-elevated)",
            color:
              input.trim() || !data.sessionKey
                ? "#fff"
                : "var(--text-muted)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
            opacity: !input.trim() && !!data.sessionKey ? 0.4 : 1,
          }}
        >
          {data.sessionKey ? "Send" : "Start"}
        </button>
      </div>

      {data.error && (
        <div
          style={{
            padding: "6px 10px",
            background: "#3a1a1a",
            color: "#f87171",
            fontSize: 11,
            borderTop: "1px solid #ef4444",
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
  type: "leader",
  label: "Leader",
  defaultSize: { width: 520, height: 460 },
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
  permissionMode: "bypassPermissions",
  completedTasks: [],
  worktreeIsolation: true,
  worktreePath: null,
  worktreeBranch: null,
  worktreeStatus: "none",
  skillIds: [],
  skillValues: {},
  skillPanelOpen: false,
};
