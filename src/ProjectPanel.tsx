import { useState, useEffect, useCallback, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  getProjectContext,
  updateProjectContext,
  getProjectTree,
  type ProjectContext,
  type TreeNode,
} from "./api.ts";
import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/LeaderNode.tsx";
import type { MinionData } from "./nodes/MinionNode.tsx";
import { ProjectTree, type LeaderActivity } from "./components/ProjectTree.tsx";

interface ProjectPanelProps {
  projectId: string;
  projectPath: string;
  projectName: string;
  onSpawnContextExplorer: () => void;
  nodes: CanvasNode[];
  /** Called when user clicks a file in the project tree */
  onOpenFile?: (relativePath: string) => void;
  /** Called when a node's data is updated from the panel (e.g. renaming a leader) */
  onUpdateNodeData?: (nodeId: string, data: unknown) => void;
  /** Called when user clicks "Focus" on an agent to center it on the canvas */
  onFocusNode?: (nodeId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────

type FilePathMessage = {
  role: string;
  content: string;
  toolName?: string | undefined;
};

const EMPTY_MESSAGES: ReadonlyArray<FilePathMessage> = [];

/** Extract file paths mentioned in tool messages */
function extractFilePaths(messages: ReadonlyArray<FilePathMessage>): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (msg.toolName === "Read" || msg.toolName === "Write" || msg.toolName === "Edit") {
      // Try to extract path from content like "Read /path/to/file" or tool summaries
      const pathMatch = msg.content.match(/(?:Read|Write|Edit|Glob|Grep)\s+([^\s(]+)/);
      if (pathMatch?.[1]) {
        paths.add(pathMatch[1]);
      }
    }
    // Also catch file paths in tool content (e.g. "src/foo.ts (2.1s)")
    const fileMatches = msg.content.match(/\b(?:src|lib|app|server|test|components)\/[\w/.@-]+\.\w+/g);
    if (fileMatches) {
      for (const f of fileMatches) paths.add(f);
    }
  }
  return [...paths].slice(-8); // last 8 files
}

export function createFilePathExtractor(): (messages: ReadonlyArray<FilePathMessage>) => string[] {
  const cache = new WeakMap<ReadonlyArray<FilePathMessage>, string[]>();
  return (messages) => {
    const cached = cache.get(messages);
    if (cached) return cached;
    const extracted = extractFilePaths(messages);
    cache.set(messages, extracted);
    return extracted;
  };
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function sameLeaderActivities(a: readonly LeaderActivity[], b: readonly LeaderActivity[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((leader, index) => {
    const next = b[index];
    return (
      next !== undefined &&
      leader.id === next.id &&
      leader.name === next.name &&
      leader.colorIndex === next.colorIndex &&
      leader.status === next.status &&
      sameStringArray(leader.files, next.files)
    );
  });
}

function shortenPath(p: string, maxLen = 36): string {
  if (p.length <= maxLen) return p;
  const parts = p.split("/");
  if (parts.length <= 2) return "…" + p.slice(-maxLen + 1);
  return parts[0] + "/…/" + parts.slice(-2).join("/");
}

type Tab = "dashboard" | "context";

// ── Status colors ────────────────────────────────────────

const STATUS_COLORS: Record<string, { dot: string; text: string; bg: string }> = {
  running:      { dot: "var(--status-success)", text: "var(--status-success)", bg: "var(--success-bg)" },
  idle:         { dot: "var(--status-idle)", text: "var(--status-idle)", bg: "var(--state-hover)" },
  creating:     { dot: "var(--status-warning)", text: "var(--status-warning)", bg: "var(--warning-bg)" },
  stopped:      { dot: "var(--status-stopped)", text: "var(--status-stopped)", bg: "var(--state-hover)" },
  error:        { dot: "var(--status-error)", text: "var(--status-error)", bg: "var(--danger-bg)" },
  disconnected: { dot: "var(--text-muted)", text: "var(--text-muted)", bg: "transparent" },
  waiting:      { dot: "var(--status-waiting)", text: "var(--status-waiting)", bg: "var(--state-hover)" },
};

function statusOf(s: string): { dot: string; text: string; bg: string } {
  return STATUS_COLORS[s] ?? STATUS_COLORS["disconnected"]!;
}

// ── Component ────────────────────────────────────────────

export function ProjectPanel({
  projectId,
  projectPath,
  projectName,
  onSpawnContextExplorer,
  nodes,
  onOpenFile,
  onUpdateNodeData,
  onFocusNode,
}: ProjectPanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const userCollapsedRef = useRef(false);
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState("");
  const [saving, setSaving] = useState(false);

  const contextIsEmpty =
    !context?.exists ||
    !context.content.trim() ||
    context.content.includes("Project context has not been configured yet.");

  // Default tab: show context setup if empty, dashboard otherwise
  const [activeTab, setActiveTab] = useState<Tab>(contextIsEmpty ? "context" : "dashboard");

  // Update default tab when context loads
  useEffect(() => {
    if (context !== null) {
      setActiveTab(contextIsEmpty ? "context" : "dashboard");
    }
  }, [context, contextIsEmpty]);

  // Load context on mount
  useEffect(() => {
    void (async () => {
      try {
        const ctx = await getProjectContext(projectId);
        setContext(ctx);
      } catch (err) {
        console.error("Failed to load context:", err);
      }
    })();
  }, [projectId]);

  const handleEditStart = useCallback(() => {
    setEditBuffer(context?.content ?? "");
    setEditing(true);
  }, [context]);

  const handleEditSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateProjectContext(projectId, editBuffer);
      setContext({ content: editBuffer, exists: true });
      setEditing(false);
    } catch (err) {
      console.error("Failed to save context:", err);
    } finally {
      setSaving(false);
    }
  }, [projectId, editBuffer]);

  const handleEditCancel = useCallback(() => {
    setEditing(false);
    setEditBuffer("");
  }, []);

  const extractFilePathsCachedRef = useRef(createFilePathExtractor());

  // ── Derive agent data from canvas nodes ──

  const agents = useMemo(() => {
    const result: Array<{
      id: string;
      type: "leader" | "minion";
      name: string;
      status: string;
      cost: number;
      turns: number;
      files: string[];
      minionCount: number;
      worktreeBranch: string | null;
    }> = [];

    for (const node of nodes) {
      if (node.type === "leader") {
        const d = node.data as LeaderData;
        if (d.status === "disconnected") continue;
        const files = extractFilePathsCachedRef.current(d.messages ?? EMPTY_MESSAGES);
        result.push({
          id: node.id,
          type: "leader",
          name: d.taskName ?? node.id.slice(0, 8),
          status: d.status,
          cost: d.totalCost,
          turns: d.turns,
          files,
          minionCount: d.taskPlan?.filter((t) => t.executor === "minion" && t.status === "completed").length ?? 0,
          worktreeBranch: d.worktreeBranch ?? null,
        });
      } else if (node.type === "minion") {
        const d = node.data as MinionData;
        if (d.status === "disconnected" || d.status === "waiting") continue;
        const activeTask = d.taskQueue?.[d.activeTaskIndex];
        const files = extractFilePathsCachedRef.current(d.messages ?? EMPTY_MESSAGES);
        result.push({
          id: node.id,
          type: "minion",
          name: activeTask?.title ?? node.id.slice(0, 8),
          status: d.status,
          cost: d.totalCost,
          turns: d.turns,
          files,
          minionCount: 0,
          worktreeBranch: d.worktreeBranch ?? null,
        });
      }
    }
    return result;
  }, [nodes]);

  const totalCost = agents.reduce((s, a) => s + a.cost, 0);
  const runningCount = agents.filter(a => a.status === "running").length;
  const hasLeaderData = agents.some(a => a.type === "leader");

  // Auto-expand when leader data arrives (unless user manually collapsed)
  useEffect(() => {
    if (hasLeaderData && !userCollapsedRef.current) {
      setCollapsed(false);
    }
    if (!hasLeaderData) {
      // Reset manual-collapse flag when all leaders disconnect,
      // so the panel will auto-open for the next leader session
      userCollapsedRef.current = false;
      setCollapsed(true);
    }
  }, [hasLeaderData]);

  // ── Tabs to show ──
  const tabs: Tab[] = contextIsEmpty ? ["context"] : ["dashboard", "context"];

  // ── Collapsed state ──

  if (collapsed) {
    return (
      <div style={{ position: "absolute", top: 12, left: 16, zIndex: 100 }}>
        <button
          onClick={() => setCollapsed(false)}
          style={{
            padding: "8px 12px",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            boxShadow: "var(--shadow-md)",
          }}
        >
          <span style={{ fontSize: 14 }}>&#9776;</span>
          <span>{projectName}</span>
          {runningCount > 0 && (
            <span
              style={{
                fontSize: 10,
                color: "var(--status-success)",
                fontFamily: "var(--font-mono)",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "var(--status-success)",
                  boxShadow: "0 0 6px var(--status-success)",
                  display: "inline-block",
                }}
              />
              {runningCount}
            </span>
          )}
          {contextIsEmpty && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--status-warning)",
                flexShrink: 0,
              }}
            />
          )}
        </button>
      </div>
    );
  }

  // ── Expanded panel ──

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 16,
        width: 340,
        maxHeight: "calc(100% - 80px)",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {projectName}
            {totalCost > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 400,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                ${totalCost.toFixed(2)}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 240,
            }}
          >
            {projectPath}
          </div>
        </div>
        <button
          onClick={() => { userCollapsedRef.current = true; setCollapsed(true); }}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
            padding: "2px 6px",
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          &#x2715;
        </button>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: "7px 0",
              fontSize: 10,
              fontWeight: 500,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              background: "transparent",
              border: "none",
              borderBottom:
                activeTab === tab
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
              color:
                activeTab === tab
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
              cursor: "pointer",
              transition: "color 0.15s, border-color 0.15s",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
          >
            {tab}
            {tab === "dashboard" && runningCount > 0 && (
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "var(--status-success)",
                  boxShadow: "0 0 6px var(--status-success)",
                  flexShrink: 0,
                }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: activeTab === "dashboard" ? "0" : "12px 14px",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ─── Dashboard Tab ─── */}
        {activeTab === "dashboard" && (
          <DashboardView
            agents={agents}
            totalCost={totalCost}
            runningCount={runningCount}
            projectId={projectId}
            projectPath={projectPath}
            onOpenFile={onOpenFile}
            nodes={nodes}
            onUpdateNodeData={onUpdateNodeData}
            onFocusNode={onFocusNode}
          />
        )}

        {/* ─── Context Tab ─── */}
        {activeTab === "context" && (
          <>
            {contextIsEmpty && !editing && (
              <div style={{ textAlign: "center", padding: "24px 12px" }}>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-muted)",
                    marginBottom: 16,
                    lineHeight: 1.5,
                  }}
                >
                  No project context configured yet. Write it yourself or let a
                  Leader agent explore and populate it.
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    justifyContent: "center",
                  }}
                >
                  <button
                    onClick={handleEditStart}
                    style={{
                      padding: "8px 16px",
                      fontSize: 12,
                      fontWeight: 500,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 6,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    Write Manually
                  </button>
                  <button
                    onClick={onSpawnContextExplorer}
                    style={{
                      padding: "8px 16px",
                      fontSize: 12,
                      fontWeight: 500,
                      background: "var(--accent)",
                      border: "1px solid color-mix(in srgb, var(--accent) 72%, var(--text-on-accent))",
                      borderRadius: 6,
                      color: "var(--text-on-accent)",
                      boxShadow:
                        "inset 0 1px 0 color-mix(in srgb, var(--text-on-accent) 22%, transparent), 0 1px 2px rgba(var(--kb-shadow-color), 0.18), 0 8px 18px color-mix(in srgb, var(--accent) 14%, transparent)",
                      cursor: "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    Generate with AI
                  </button>
                </div>
              </div>
            )}

            {editing && (
              <div>
                <textarea
                  value={editBuffer}
                  onChange={(e) => setEditBuffer(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: 200,
                    padding: "10px 12px",
                    fontSize: 12,
                    lineHeight: 1.6,
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 6,
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                    resize: "vertical",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                  onFocus={(e) =>
                    (e.currentTarget.style.borderColor = "var(--accent)")
                  }
                  onBlur={(e) =>
                    (e.currentTarget.style.borderColor =
                      "var(--border-default)")
                  }
                />
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginTop: 8,
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    onClick={handleEditCancel}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      background: "transparent",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleEditSave()}
                    disabled={saving}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      background: "var(--accent)",
                      border: "none",
                      borderRadius: 4,
                      color: "var(--text-primary)",
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            )}

            {!contextIsEmpty && !editing && (
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginBottom: 8,
                    gap: 6,
                  }}
                >
                  <button
                    onClick={handleEditStart}
                    style={{
                      padding: "4px 10px",
                      fontSize: 10,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={onSpawnContextExplorer}
                    style={{
                      padding: "4px 10px",
                      fontSize: 10,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Regenerate
                  </button>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-sans)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {context?.content}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Inline editable agent name ──────────────────────────────

function InlineEditName({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  if (!editing) {
    return (
      <span
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title={`${value} (double-click to rename)`}
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          fontWeight: 500,
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
          cursor: "default",
        }}
      >
        {value}
      </span>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onChange(trimmed);
    setEditing(false);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: ReactKeyboardEvent) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value); setEditing(false); }
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        all: "unset",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        fontWeight: 500,
        color: "var(--text-primary)",
        background: "var(--bg-primary)",
        border: "1px solid var(--border-active)",
        borderRadius: 3,
        padding: "0 4px",
        flex: 1,
        minWidth: 0,
        boxSizing: "border-box",
      }}
    />
  );
}

// ── Dashboard Sub-component ──────────────────────────────

function DashboardView({
  agents,
  totalCost,
  runningCount,
  projectId,
  projectPath,
  onOpenFile,
  nodes,
  onUpdateNodeData,
  onFocusNode,
}: {
  agents: Array<{
    id: string;
    type: "leader" | "minion";
    name: string;
    status: string;
    cost: number;
    turns: number;
    files: string[];
    minionCount: number;
    worktreeBranch: string | null;
  }>;
  totalCost: number;
  runningCount: number;
  projectId: string;
  projectPath: string;
  onOpenFile?: ((relativePath: string) => void) | undefined;
  nodes?: CanvasNode[] | undefined;
  onUpdateNodeData?: ((nodeId: string, data: unknown) => void) | undefined;
  onFocusNode?: ((nodeId: string) => void) | undefined;
}) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [rootName, setRootName] = useState("");
  const [treeError, setTreeError] = useState(false);
  const [viewMode, setViewMode] = useState<"tree" | "agents">("tree");
  const [filterActive, setFilterActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const fetchedRef = useRef(false);
  const leaderActivitiesRef = useRef<LeaderActivity[] | null>(null);

  const refreshTree = useCallback(async () => {
    try {
      const result = await getProjectTree(projectId, 3);
      setTree(result.tree);
      setRootName(result.root);
    } catch {
      setTreeError(true);
    }
  }, [projectId]);

  // Fetch tree on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void refreshTree();
  }, [refreshTree]);

  // Build leader activity list for the tree
  const leaderActivities: LeaderActivity[] = useMemo(() => {
    const next = agents
      .filter(a => a.type === "leader")
      .map((a, i) => ({
        id: a.id,
        name: a.name !== a.id.slice(0, 8)
          ? a.name  // taskName is set — use it directly
          : a.worktreeBranch
            ? a.worktreeBranch.replace(/^canvas-/, "").slice(0, 16)
            : a.name,
        colorIndex: i,
        status: a.status as LeaderActivity["status"],
        files: a.files,
      }));
    const previous = leaderActivitiesRef.current;
    if (previous && sameLeaderActivities(previous, next)) {
      return previous;
    }
    leaderActivitiesRef.current = next;
    return next;
  }, [agents]);

  if (agents.length === 0 && !tree) {
    return (
      <div
        style={{
          padding: "32px 20px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: "var(--bg-elevated)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            color: "var(--text-muted)",
          }}
        >
          &#9671;
        </div>
        <div
          style={{
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          No active agents.
          <br />
          <span style={{ fontSize: 11, opacity: 0.7 }}>
            Launch a task from the Kanban board or add a Leader node on the canvas.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Summary strip */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {/* Stats */}
        <div
          style={{
            display: "flex",
            gap: 12,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            flex: 1,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {runningCount > 0 && (
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "var(--status-success)",
                  boxShadow: "0 0 6px var(--status-success)",
                  display: "inline-block",
                }}
              />
            )}
            <span style={{ color: runningCount > 0 ? "var(--status-success)" : "var(--text-muted)" }}>
              {runningCount} active
            </span>
          </span>
          <span>{agents.length} total</span>
          {totalCost > 0 && <span>${totalCost.toFixed(2)}</span>}
        </div>

        {/* View toggle */}
        <div
          style={{
            display: "flex",
            background: "var(--bg-primary)",
            borderRadius: 5,
            padding: 1,
            gap: 1,
          }}
        >
          <button
            onClick={() => setViewMode("tree")}
            style={{
              padding: "3px 8px",
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              fontWeight: viewMode === "tree" ? 600 : 400,
              background: viewMode === "tree" ? "var(--bg-elevated)" : "transparent",
              border: "none",
              borderRadius: 4,
              color: viewMode === "tree" ? "var(--text-primary)" : "var(--text-muted)",
              cursor: "pointer",
              transition: "all 0.12s ease",
              letterSpacing: 0.3,
              textTransform: "uppercase",
            }}
          >
            Tree
          </button>
          <button
            onClick={() => setViewMode("agents")}
            style={{
              padding: "3px 8px",
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              fontWeight: viewMode === "agents" ? 600 : 400,
              background: viewMode === "agents" ? "var(--bg-elevated)" : "transparent",
              border: "none",
              borderRadius: 4,
              color: viewMode === "agents" ? "var(--text-primary)" : "var(--text-muted)",
              cursor: "pointer",
              transition: "all 0.12s ease",
              letterSpacing: 0.3,
              textTransform: "uppercase",
            }}
          >
            Agents
          </button>
        </div>
      </div>

      {viewMode === "tree" && (
        <>
          {/* In-tree fuzzy filter */}
          <div
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid var(--border-default)",
              position: "relative",
            }}
          >
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter files…"
              aria-label="Filter files"
              style={{
                width: "100%",
                padding: "6px 28px 6px 10px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 6,
                color: "var(--text-primary)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear filter"
                style={{
                  position: "absolute",
                  right: 18,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: 4,
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            )}
          </div>

          {/* Filter toggle for tree view */}
          {leaderActivities.some(l => l.files.length > 0) && (
            <div
              style={{
                padding: "6px 12px",
                borderBottom: "1px solid var(--border-default)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <button
                onClick={() => setFilterActive(!filterActive)}
                style={{
                  padding: "2px 8px",
                  fontSize: 9,
                  fontFamily: "var(--font-mono)",
                  background: filterActive ? "var(--state-active)" : "transparent",
                  border: filterActive ? "1px solid var(--accent)" : "1px solid var(--border-default)",
                  borderRadius: 4,
                  color: filterActive ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  letterSpacing: 0.3,
                }}
              >
                {filterActive ? "Showing touched only" : "Filter to active"}
              </button>
            </div>
          )}

          {/* Tree view */}
          {tree ? (
            <ProjectTree
              tree={tree}
              rootName={rootName}
              leaders={leaderActivities}
              projectPath={projectPath}
              filterActive={filterActive}
              query={searchQuery}
              onFileClick={onOpenFile}
              onTreeChanged={refreshTree}
            />
          ) : treeError ? (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 11,
              }}
            >
              Could not load directory tree.
            </div>
          ) : (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              Loading tree...
            </div>
          )}
        </>
      )}

      {viewMode === "agents" && (
        <div style={{ padding: "6px" }}>
          {agents.map((agent) => {
            const st = statusOf(agent.status);
            // Find matching leader color index
            const leaderMatch = leaderActivities.find(l => l.id === agent.id);
            const colorIdx = leaderMatch?.colorIndex;
            return (
              <div
                key={agent.id}
                style={{
                  padding: "10px 10px 8px",
                  marginBottom: 4,
                  borderRadius: 6,
                  background: st.bg,
                  border: "1px solid var(--border-default)",
                  transition: "background 0.2s",
                }}
              >
                {/* Top row: type badge + name + status */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    marginBottom: 6,
                  }}
                >
                  {/* Color pip matching tree legend */}
                  {colorIdx != null && (
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: LEADER_HUES[colorIdx % LEADER_HUES.length]!.dot,
                        boxShadow: agent.status === "running"
                          ? `0 0 6px ${LEADER_HUES[colorIdx % LEADER_HUES.length]!.ring}`
                          : "none",
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: "var(--font-mono)",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      padding: "1px 5px",
                      borderRadius: 3,
                      fontWeight: 600,
                      background:
                        agent.type === "leader"
                          ? "var(--state-active)"
                          : "var(--state-hover)",
                      color:
                        agent.type === "leader" ? "var(--accent)" : "var(--accent)",
                      flexShrink: 0,
                    }}
                  >
                    {agent.type === "leader" ? "LDR" : "MIN"}
                  </span>
                  {agent.type === "leader" && onUpdateNodeData ? (
                    <InlineEditName
                      value={agent.name}
                      onChange={(newName) => {
                        const node = nodes?.find(n => n.id === agent.id);
                        if (node) {
                          onUpdateNodeData(agent.id, { ...(node.data as Record<string, unknown>), taskName: newName });
                        }
                      }}
                    />
                  ) : (
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {agent.name}
                    </span>
                  )}
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: st.dot,
                        boxShadow:
                          agent.status === "running"
                            ? `0 0 6px ${st.dot}`
                            : "none",
                        display: "inline-block",
                      }}
                    />
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: "var(--font-mono)",
                        textTransform: "uppercase",
                        color: st.text,
                      }}
                    >
                      {agent.status}
                    </span>
                  </span>
                </div>

                {/* Stats row */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-muted)",
                    marginBottom: agent.files.length > 0 || agent.worktreeBranch ? 6 : 0,
                  }}
                >
                  {agent.turns > 0 && <span>{agent.turns} turns</span>}
                  {agent.cost > 0 && <span>${agent.cost.toFixed(3)}</span>}
                  {agent.type === "leader" && agent.minionCount > 0 && (
                    <span>{agent.minionCount} tasks</span>
                  )}
                  {onFocusNode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onFocusNode(agent.id);
                      }}
                      title="Focus node on canvas"
                      style={{
                        marginLeft: "auto",
                        padding: "2px 7px",
                        fontSize: 9,
                        fontFamily: "var(--font-mono)",
                        fontWeight: 500,
                        letterSpacing: 0.3,
                        background: "transparent",
                        border: "1px solid var(--border-default)",
                        borderRadius: 4,
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        flexShrink: 0,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--accent)";
                        e.currentTarget.style.color = "var(--accent)";
                        e.currentTarget.style.background = "var(--state-active)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border-default)";
                        e.currentTarget.style.color = "var(--text-muted)";
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span style={{ fontSize: 10, lineHeight: 1 }}>&#8982;</span>
                      Focus
                    </button>
                  )}
                </div>

                {/* Worktree branch */}
                {agent.worktreeBranch && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      marginBottom: agent.files.length > 0 ? 6 : 0,
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                      color: "var(--accent)",
                    }}
                  >
                    <span style={{ opacity: 0.6 }}>&#9095;</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {agent.worktreeBranch}
                    </span>
                  </div>
                )}

                {/* Recent files */}
                {agent.files.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    {agent.files.slice(-4).map((f) => (
                      <div
                        key={f}
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          paddingLeft: 8,
                          borderLeft: "2px solid var(--border-default)",
                        }}
                        title={f}
                      >
                        {shortenPath(f)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Leader color palette — shared between tree and agents view
const LEADER_HUES = [
  { dot: "var(--priority-high)", ring: "color-mix(in srgb, var(--priority-high) 30%, transparent)" },
  { dot: "var(--tool-accent)", ring: "color-mix(in srgb, var(--tool-accent) 30%, transparent)" },
  { dot: "var(--status-success)", ring: "color-mix(in srgb, var(--status-success) 30%, transparent)" },
  { dot: "var(--status-error)", ring: "color-mix(in srgb, var(--status-error) 30%, transparent)" },
  { dot: "var(--streaming-color)", ring: "color-mix(in srgb, var(--streaming-color) 30%, transparent)" },
  { dot: "var(--status-warning)", ring: "color-mix(in srgb, var(--status-warning) 30%, transparent)" },
  { dot: "var(--status-waiting)", ring: "color-mix(in srgb, var(--status-waiting) 30%, transparent)" },
  { dot: "var(--danger-color-text)", ring: "color-mix(in srgb, var(--danger-color-text) 30%, transparent)" },
];
