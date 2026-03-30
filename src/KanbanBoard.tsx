import { useState, useCallback, useEffect, type Dispatch } from "react";
import type { KanbanBoard as KanbanBoardType, KanbanCard, KanbanAction, KanbanSubtask } from "./kanban-types.ts";

// ─── Helpers ──────────────────────────────────────────────

let _idCounter = 0;
function genId(): string {
  return `kb-${Date.now()}-${++_idCounter}`;
}

const PRIORITY_COLORS: Record<KanbanCard["priority"], string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#3b82f6",
  low: "#6b7280",
};

const PRIORITY_LABELS: Record<KanbanCard["priority"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ─── Card Form ────────────────────────────────────────────

interface CardFormData {
  title: string;
  description: string;
  context: string;
  priority: KanbanCard["priority"];
  subtasks: KanbanSubtask[];
}

function CardForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial?: CardFormData;
  onSubmit: (data: CardFormData) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [context, setContext] = useState(initial?.context ?? "");
  const [priority, setPriority] = useState<KanbanCard["priority"]>(initial?.priority ?? "medium");
  const [subtasks, setSubtasks] = useState<KanbanSubtask[]>(initial?.subtasks ?? []);
  const [newSubtask, setNewSubtask] = useState("");

  const handleAddSubtask = () => {
    const trimmed = newSubtask.trim();
    if (!trimmed) return;
    setSubtasks((prev) => [...prev, { id: genId(), title: trimmed, done: false }]);
    setNewSubtask("");
  };

  const handleSubmit = () => {
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), description, context, priority, subtasks });
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    background: "var(--bg-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
  };

  const textareaStyle: React.CSSProperties = {
    ...inputStyle,
    minHeight: 48,
    resize: "vertical",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}>
      <input
        style={inputStyle}
        placeholder="Card title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        autoFocus
      />
      <textarea
        style={textareaStyle}
        placeholder="Description (becomes the Leader prompt)..."
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
      />
      <textarea
        style={textareaStyle}
        placeholder="Context (file paths, constraints, etc.)..."
        value={context}
        onChange={(e) => setContext(e.target.value)}
        rows={2}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--text-secondary)" }}>
          Priority:
        </label>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as KanbanCard["priority"])}
          style={{
            ...inputStyle,
            width: "auto",
            cursor: "pointer",
          }}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      {/* Subtasks */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--text-secondary)" }}>
          Subtasks:
        </span>
        {subtasks.map((st) => (
          <div key={st.id} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-primary)", flex: 1, fontFamily: "var(--font-sans)" }}>
              {st.title}
            </span>
            <button
              onClick={() => setSubtasks((prev) => prev.filter((s) => s.id !== st.id))}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 14,
                padding: "0 4px",
              }}
              title="Remove subtask"
            >
              x
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 4 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            placeholder="New subtask..."
            value={newSubtask}
            onChange={(e) => setNewSubtask(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddSubtask()}
          />
          <button
            onClick={handleAddSubtask}
            style={{
              padding: "4px 10px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
        <button
          onClick={onCancel}
          style={{
            padding: "5px 14px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!title.trim()}
          style={{
            padding: "5px 14px",
            background: title.trim() ? "linear-gradient(135deg, #818cf8, #6366f1)" : "var(--bg-elevated)",
            border: "none",
            borderRadius: 6,
            color: title.trim() ? "#fff" : "var(--text-muted)",
            cursor: title.trim() ? "pointer" : "default",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
          }}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ─── Backlog Card ────────────────────────────────────────

function BacklogCard({
  card,
  dispatch,
  onLaunchLeader,
}: {
  card: KanbanCard;
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  const doneCount = card.subtasks.filter((s) => s.done).length;
  const totalCount = card.subtasks.length;

  if (editing) {
    return (
      <div
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <CardForm
          initial={{
            title: card.title,
            description: card.description,
            context: card.context,
            priority: card.priority,
            subtasks: card.subtasks,
          }}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(data) => {
            dispatch({
              type: "UPDATE_CARD",
              cardId: card.id,
              data: {
                title: data.title,
                description: data.description,
                context: data.context,
                priority: data.priority,
                subtasks: data.subtasks,
              },
            });
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
      }}
    >
      {/* Card header */}
      <div
        style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PRIORITY_COLORS[card.priority],
            flexShrink: 0,
          }}
          title={PRIORITY_LABELS[card.priority]}
        />
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            color: "var(--text-primary)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.title}
        </span>
        {totalCount > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: doneCount === totalCount ? "#22c55e" : "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            {doneCount}/{totalCount}
          </span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Description */}
          {card.description && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                background: "var(--bg-primary)",
                borderRadius: 4,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                maxHeight: 80,
                overflow: "auto",
              }}
            >
              {card.description}
            </div>
          )}

          {/* Context */}
          {card.context && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                background: "var(--bg-primary)",
                borderRadius: 4,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                maxHeight: 60,
                overflow: "auto",
              }}
            >
              {card.context}
            </div>
          )}

          {/* Subtasks (read-only, no checkboxes) */}
          {card.subtasks.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {card.subtasks.map((st) => (
                <div
                  key={st.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontFamily: "var(--font-sans)",
                    color: "var(--text-primary)",
                    paddingLeft: 4,
                  }}
                >
                  <span style={{ color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }}>&#8226;</span>
                  {st.title}
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <button
              onClick={() => onLaunchLeader(card)}
              style={{
                flex: 1,
                padding: "5px 0",
                background: "linear-gradient(135deg, #818cf8, #6366f1)",
                border: "none",
                borderRadius: 5,
                color: "#fff",
                fontSize: 11,
                fontFamily: "var(--font-sans)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ▶ Launch
            </button>
            <button
              onClick={() => setEditing(true)}
              style={{
                padding: "5px 10px",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                borderRadius: 5,
                color: "var(--text-secondary)",
                fontSize: 11,
                fontFamily: "var(--font-sans)",
                cursor: "pointer",
              }}
            >
              Edit
            </button>
            <button
              onClick={() => dispatch({ type: "REMOVE_CARD", cardId: card.id })}
              style={{
                padding: "5px 10px",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                borderRadius: 5,
                color: "#ef4444",
                fontSize: 11,
                fontFamily: "var(--font-sans)",
                cursor: "pointer",
              }}
            >
              Del
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── In Progress Card ────────────────────────────────────

interface LeaderStatus {
  status: string;
  worktreeStatus: string;
  cost: number;
  turns: number;
}

function InProgressCard({
  card,
  leaderStatus,
  onFocusNode,
}: {
  card: KanbanCard;
  leaderStatus?: LeaderStatus;
  onFocusNode?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const doneCount = card.subtasks.filter((s) => s.done).length;
  const totalCount = card.subtasks.length;

  // Determine status display
  let statusDot: React.CSSProperties;
  let statusText: string;

  if (!leaderStatus) {
    statusDot = { background: "#6b7280" };
    statusText = "Waiting...";
  } else if (leaderStatus.status === "running" || leaderStatus.status === "creating") {
    statusDot = {
      background: "#f59e0b",
      animation: "kanban-pulse 1.5s ease-in-out infinite",
    };
    statusText = leaderStatus.status === "creating" ? "Starting..." : "Running...";
  } else if (leaderStatus.status === "idle" && leaderStatus.worktreeStatus !== "active") {
    statusDot = { background: "#22c55e" };
    statusText = "Idle";
  } else {
    statusDot = { background: "#f59e0b" };
    statusText = "Working...";
  }

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
      }}
    >
      {/* Pulse animation */}
      <style>{`
        @keyframes kanban-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      {/* Card header */}
      <div
        style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PRIORITY_COLORS[card.priority],
            flexShrink: 0,
          }}
          title={PRIORITY_LABELS[card.priority]}
        />
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            color: "var(--text-primary)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.title}
        </span>
        {totalCount > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: doneCount === totalCount ? "#22c55e" : "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            {doneCount}/{totalCount}
          </span>
        )}
      </div>

      {/* Live status indicator */}
      <div
        style={{
          padding: "0 10px 6px",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flexShrink: 0,
            ...statusDot,
          }}
        />
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-sans)",
            color: "var(--text-secondary)",
          }}
        >
          {statusText}
        </span>
        {leaderStatus && leaderStatus.cost > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              marginLeft: "auto",
            }}
          >
            ${leaderStatus.cost.toFixed(2)}
          </span>
        )}
        {card.leaderNodeId && onFocusNode && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFocusNode(card.leaderNodeId!);
            }}
            style={{
              background: "none",
              border: "none",
              fontSize: 11,
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "2px 6px",
              fontFamily: "var(--font-sans)",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "var(--accent, #818cf8)"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "var(--text-secondary)"; }}
            title="View on Canvas"
          >
            📍 View
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {card.description && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                background: "var(--bg-primary)",
                borderRadius: 4,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                maxHeight: 80,
                overflow: "auto",
              }}
            >
              {card.description}
            </div>
          )}

          {card.context && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                background: "var(--bg-primary)",
                borderRadius: 4,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                maxHeight: 60,
                overflow: "auto",
              }}
            >
              {card.context}
            </div>
          )}

          {/* Subtasks (read-only) */}
          {card.subtasks.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {card.subtasks.map((st) => (
                <div
                  key={st.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontFamily: "var(--font-sans)",
                    color: st.done ? "var(--text-muted)" : "var(--text-primary)",
                    textDecoration: st.done ? "line-through" : "none",
                    paddingLeft: 4,
                  }}
                >
                  <span style={{ color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }}>
                    {st.done ? "✓" : "&#8226;"}
                  </span>
                  {st.title}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Review Card ─────────────────────────────────────────

function ReviewCard({
  card,
  onCloseCard,
  onFocusNode,
}: {
  card: KanbanCard;
  onCloseCard: (card: KanbanCard) => void;
  onFocusNode?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
      }}
    >
      {/* Card header */}
      <div
        style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PRIORITY_COLORS[card.priority],
            flexShrink: 0,
          }}
          title={PRIORITY_LABELS[card.priority]}
        />
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            color: "var(--text-primary)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.title}
        </span>
        {/* Ready for Review badge */}
        <span
          style={{
            fontSize: 9,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            color: "#3b82f6",
            background: "#3b82f622",
            border: "1px solid #3b82f644",
            borderRadius: 8,
            padding: "1px 6px",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          Ready for Review
        </span>
      </div>

      {/* Action buttons */}
      <div style={{ padding: "0 10px 8px", display: "flex", gap: 6 }}>
        <button
          onClick={() => onCloseCard(card)}
          style={{
            flex: 1,
            padding: "5px 0",
            background: "linear-gradient(135deg, #22c55e, #16a34a)",
            border: "none",
            borderRadius: 5,
            color: "#fff",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ✓ Close
        </button>
        {card.leaderNodeId && onFocusNode && (
          <button
            onClick={() => onFocusNode(card.leaderNodeId!)}
            style={{
              background: "none",
              border: "none",
              fontSize: 11,
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "2px 6px",
              fontFamily: "var(--font-sans)",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.color = "var(--accent, #818cf8)"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.color = "var(--text-secondary)"; }}
            title="View on Canvas"
          >
            📍 View
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {card.description && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                background: "var(--bg-primary)",
                borderRadius: 4,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                maxHeight: 80,
                overflow: "auto",
              }}
            >
              {card.description}
            </div>
          )}

          {card.agentSummary && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                background: "var(--bg-primary)",
                borderRadius: 4,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                maxHeight: 80,
                overflow: "auto",
              }}
            >
              {card.agentSummary}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── History Card ────────────────────────────────────────

function HistoryCard({ card }: { card: KanbanCard }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        opacity: 0.6,
      }}
    >
      {/* Card header */}
      <div
        style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: PRIORITY_COLORS[card.priority],
            flexShrink: 0,
          }}
          title={PRIORITY_LABELS[card.priority]}
        />
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            color: "var(--text-primary)",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.title}
        </span>
        {card.agentCost != null && card.agentCost > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            ${card.agentCost.toFixed(2)}
          </span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {card.agentSummary && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                background: "var(--bg-primary)",
                borderRadius: 4,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                maxHeight: 80,
                overflow: "auto",
              }}
            >
              {card.agentSummary}
            </div>
          )}

          {card.agentCost != null && (
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
              }}
            >
              Total cost: ${card.agentCost.toFixed(2)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Column Component ─────────────────────────────────────

function KanbanColumnComponent({
  column,
  cards,
  dispatch,
  onLaunchLeader,
  onCloseCard,
  leaderStatuses,
  onFocusNode,
}: {
  column: { id: string; title: string; color: string };
  cards: KanbanCard[];
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
  onCloseCard: (card: KanbanCard) => void;
  leaderStatuses: Map<string, LeaderStatus>;
  onFocusNode?: (nodeId: string) => void;
}) {
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 180,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderRadius: 6,
        border: "2px solid transparent",
        padding: 4,
      }}
    >
      {/* Column header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          marginBottom: 6,
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 3,
            background: column.color,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {column.title}
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            marginLeft: "auto",
          }}
        >
          {cards.length}
        </span>
      </div>

      {/* Cards list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          paddingRight: 4,
        }}
      >
        {cards.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 48,
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              color: "var(--text-muted)",
              fontStyle: "italic",
              opacity: 0.7,
            }}
          >
            No cards yet
          </div>
        ) : (
          cards.map((card) => {
            switch (column.id) {
              case "backlog":
                return (
                  <BacklogCard
                    key={card.id}
                    card={card}
                    dispatch={dispatch}
                    onLaunchLeader={onLaunchLeader}
                  />
                );
              case "in-progress":
                return (
                  <InProgressCard
                    key={card.id}
                    card={card}
                    leaderStatus={card.leaderNodeId ? leaderStatuses.get(card.leaderNodeId) : undefined}
                    onFocusNode={onFocusNode}
                  />
                );
              case "review":
                return (
                  <ReviewCard
                    key={card.id}
                    card={card}
                    onCloseCard={onCloseCard}
                    onFocusNode={onFocusNode}
                  />
                );
              case "history":
                return <HistoryCard key={card.id} card={card} />;
              default:
                return null;
            }
          })
        )}
      </div>
    </div>
  );
}

// ─── Main Board Component ─────────────────────────────────

interface KanbanBoardProps {
  board: KanbanBoardType;
  dispatch: Dispatch<KanbanAction>;
  onLaunchLeader: (card: KanbanCard) => void;
  /** Map of leaderNodeId -> leader status info for In Progress cards */
  leaderStatuses: Map<string, LeaderStatus>;
  /** Called when user closes a card from Ready for Review */
  onCloseCard: (card: KanbanCard) => void;
  /** Called to focus/center a canvas node by ID */
  onFocusNode?: (nodeId: string) => void;
}

export function KanbanBoard({ board, dispatch, onLaunchLeader, leaderStatuses, onCloseCard, onFocusNode }: KanbanBoardProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  const totalCards = board.cards.length;

  const handleAddCard = useCallback(
    (data: CardFormData) => {
      const card: KanbanCard = {
        id: genId(),
        title: data.title,
        description: data.description,
        context: data.context,
        priority: data.priority,
        subtasks: data.subtasks,
        columnId: "backlog",
        createdAt: Date.now(),
      };
      dispatch({ type: "ADD_CARD", card });
      setShowAddForm(false);
    },
    [dispatch],
  );

  // Build column summary chips for collapsed bar
  const columnSummary = board.columns.map((col) => ({
    id: col.id,
    title: col.title,
    color: col.color,
    count: board.cards.filter((c) => c.columnId === col.id).length,
  }));

  // Review column urgency data
  const reviewCards = board.cards.filter((c) => c.columnId === "review");
  const reviewCount = reviewCards.length;
  const priorityOrder: KanbanCard["priority"][] = ["critical", "high", "medium", "low"];
  const highestReviewCard = reviewCards.length > 0
    ? reviewCards.sort((a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority))[0]
    : null;
  const reviewPriorityColor = highestReviewCard ? PRIORITY_COLORS[highestReviewCard.priority] : "#3b82f6";

  // Pulsing state for review urgency
  const [reviewPulse, setReviewPulse] = useState(true);
  useEffect(() => {
    if (reviewCount === 0) return;
    const interval = setInterval(() => setReviewPulse((v) => !v), 1000);
    return () => clearInterval(interval);
  }, [reviewCount]);

  // Collapsed bar
  if (collapsed) {
    return (
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 40,
          zIndex: 200,
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-default)",
          borderLeft: "3px solid var(--accent, #818cf8)",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 10,
        }}
      >
        <button
          onClick={() => setCollapsed(false)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 16,
            padding: "0 4px",
            fontFamily: "var(--font-sans)",
          }}
          title="Expand Kanban board"
        >
          ▼
        </button>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Kanban
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          ({totalCards} task{totalCards !== 1 ? "s" : ""})
        </span>
        {/* Column summary chips */}
        <div style={{ display: "flex", gap: 6, marginLeft: 4, alignItems: "center" }}>
          {columnSummary.map((col) => {
            const isReview = col.id === "review";
            const hasReviewItems = isReview && reviewCount > 0;

            return (
              <span
                key={col.title}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 8px",
                  borderRadius: 10,
                  background: hasReviewItems ? reviewPriorityColor : `${col.color}22`,
                  border: hasReviewItems ? `1px solid ${reviewPriorityColor}` : `1px solid ${col.color}44`,
                  fontSize: 10,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  color: hasReviewItems ? "#fff" : col.color,
                  whiteSpace: "nowrap",
                  opacity: hasReviewItems ? (reviewPulse ? 1 : 0.6) : 1,
                  transition: "opacity 0.3s ease",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: hasReviewItems ? "#fff" : col.color,
                    flexShrink: 0,
                  }}
                />
                {isReview && highestReviewCard ? (
                  <>
                    Review: {reviewCount}
                    {" — "}
                    {highestReviewCard.title.length > 25
                      ? highestReviewCard.title.slice(0, 25) + "…"
                      : highestReviewCard.title}
                  </>
                ) : (
                  <>{col.title}: {col.count}</>
                )}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  // Expanded panel
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 300,
        zIndex: 200,
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-default)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 12px",
          borderBottom: "1px solid var(--border-default)",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setCollapsed(true)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 16,
            padding: "0 4px",
            fontFamily: "var(--font-sans)",
          }}
          title="Collapse Kanban board"
        >
          ▲
        </button>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Kanban
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {totalCards} task{totalCards !== 1 ? "s" : ""}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowAddForm((v) => !v)}
          style={{
            padding: "3px 12px",
            background: showAddForm ? "var(--bg-elevated)" : "linear-gradient(135deg, #818cf8, #6366f1)",
            border: showAddForm ? "1px solid var(--border-default)" : "none",
            borderRadius: 5,
            color: showAddForm ? "var(--text-secondary)" : "#fff",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {showAddForm ? "Cancel" : "+ Add Card"}
        </button>
      </div>

      {/* Add form (overlay) */}
      {showAddForm && (
        <div
          style={{
            position: "absolute",
            top: 38,
            right: 12,
            width: 340,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            zIndex: 210,
          }}
        >
          <CardForm
            submitLabel="Add Card"
            onSubmit={handleAddCard}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Columns area */}
      <div
        style={{
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          display: "flex",
          gap: 12,
          padding: "8px 12px",
        }}
      >
        {board.columns.map((col) => {
          const columnCards = board.cards.filter((c) => c.columnId === col.id);
          return (
            <KanbanColumnComponent
              key={col.id}
              column={col}
              cards={columnCards}
              dispatch={dispatch}
              onLaunchLeader={onLaunchLeader}
              onCloseCard={onCloseCard}
              leaderStatuses={leaderStatuses}
              onFocusNode={onFocusNode}
            />
          );
        })}
      </div>
    </div>
  );
}
