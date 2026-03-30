import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  getProjectContext,
  updateProjectContext,
  getProjectTree,
  type ProjectContext,
  type ProjectSettings,
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
  settings: ProjectSettings;
  onSpawnContextExplorer: () => void;
  nodes: CanvasNode[];
}

// ── Helpers ──────────────────────────────────────────────

/** Extract file paths mentioned in tool messages */
function extractFilePaths(messages: Array<{ role: string; content: string; toolName?: string }>): string[] {
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

function shortenPath(p: string, maxLen = 36): string {
  if (p.length <= maxLen) return p;
  const parts = p.split("/");
  if (parts.length <= 2) return "…" + p.slice(-maxLen + 1);
  return parts[0] + "/…/" + parts.slice(-2).join("/");
}

type Tab = "dashboard" | "context" | "settings";

// ── Status colors ────────────────────────────────────────

const STATUS_COLORS: Record<string, { dot: string; text: string; bg: string }> = {
  running:      { dot: "#34d399", text: "#34d399", bg: "rgba(52,211,153,0.08)" },
  idle:         { dot: "#60a5fa", text: "#60a5fa", bg: "rgba(96,165,250,0.06)" },
  creating:     { dot: "#fbbf24", text: "#fbbf24", bg: "rgba(251,191,36,0.06)" },
  stopped:      { dot: "#78716c", text: "#78716c", bg: "rgba(120,113,108,0.06)" },
  error:        { dot: "#f87171", text: "#f87171", bg: "rgba(248,113,113,0.06)" },
  disconnected: { dot: "#57534e", text: "#57534e", bg: "transparent" },
  waiting:      { dot: "#a78bfa", text: "#a78bfa", bg: "rgba(167,139,250,0.06)" },
};

function statusOf(s: string) {
  return STATUS_COLORS[s] ?? STATUS_COLORS.disconnected;
}

// ── Component ────────────────────────────────────────────

export function ProjectPanel({
  projectId,
  projectPath,
  projectName,
  settings,
  onSpawnContextExplorer,
  nodes,
}: ProjectPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
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
        const files = extractFilePaths(d.messages ?? []);
        result.push({
          id: node.id,
          type: "leader",
          name: d.messages?.find(m => m.content?.startsWith("Session on"))
            ? node.id.slice(0, 8)
            : node.id.slice(0, 8),
          status: d.status,
          cost: d.totalCost,
          turns: d.turns,
          files,
          minionCount: d.completedTasks?.length ?? 0,
          worktreeBranch: d.worktreeBranch ?? null,
        });
      } else if (node.type === "minion") {
        const d = node.data as MinionData;
        if (d.status === "disconnected" || d.status === "waiting") continue;
        const activeTask = d.taskQueue?.[d.activeTaskIndex];
        const files = extractFilePaths(d.messages ?? []);
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

  // ── Tabs to show ──
  const tabs: Tab[] = contextIsEmpty
    ? ["context", "settings"]
    : ["dashboard", "context", "settings"];

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
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <span style={{ fontSize: 14 }}>&#9776;</span>
          <span>{projectName}</span>
          {runningCount > 0 && (
            <span
              style={{
                fontSize: 10,
                color: "#34d399",
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
                  background: "#34d399",
                  boxShadow: "0 0 6px #34d399",
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
                background: "#fbbf24",
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
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
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
          onClick={() => setCollapsed(true)}
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
              position: "relative",
            }}
          >
            {tab}
            {tab === "dashboard" && runningCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  right: "calc(50% - 28px)",
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "#34d399",
                  boxShadow: "0 0 6px #34d399",
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
                      background: "linear-gradient(135deg, #818cf8, #6366f1)",
                      border: "none",
                      borderRadius: 6,
                      color: "#fff",
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
                      color: "#fff",
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

        {/* ─── Settings Tab ─── */}
        {activeTab === "settings" && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 4,
                }}
              >
                Default Model
              </label>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  padding: "6px 10px",
                  background: "var(--bg-primary)",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {settings.defaultModel ?? "sonnet"}
              </div>
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 4,
                }}
              >
                Default Permission Mode
              </label>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  padding: "6px 10px",
                  background: "var(--bg-primary)",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {settings.defaultPermissionMode ?? "bypassPermissions"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Dashboard Sub-component ──────────────────────────────

function DashboardView({
  agents,
  totalCost,
  runningCount,
  projectId,
  projectPath,
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
}) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [rootName, setRootName] = useState("");
  const [treeError, setTreeError] = useState(false);
  const [viewMode, setViewMode] = useState<"tree" | "agents">("tree");
  const [filterActive, setFilterActive] = useState(false);
  const fetchedRef = useRef(false);

  // Fetch tree on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void (async () => {
      try {
        const result = await getProjectTree(projectId, 3);
        setTree(result.tree);
        setRootName(result.root);
      } catch {
        setTreeError(true);
      }
    })();
  }, [projectId]);

  // Build leader activity list for the tree
  const leaderActivities: LeaderActivity[] = useMemo(() => {
    return agents
      .filter(a => a.type === "leader")
      .map((a, i) => ({
        id: a.id,
        name: a.worktreeBranch
          ? a.worktreeBranch.replace(/^canvas-/, "").slice(0, 16)
          : a.name,
        colorIndex: i,
        status: a.status as LeaderActivity["status"],
        files: a.files,
      }));
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
                  background: "#34d399",
                  boxShadow: "0 0 6px #34d399",
                  display: "inline-block",
                }}
              />
            )}
            <span style={{ color: runningCount > 0 ? "#34d399" : "var(--text-muted)" }}>
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
                  background: filterActive ? "rgba(240,136,62,0.12)" : "transparent",
                  border: filterActive ? "1px solid rgba(240,136,62,0.25)" : "1px solid var(--border-default)",
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
                        background: LEADER_HUES[colorIdx % LEADER_HUES.length].dot,
                        boxShadow: agent.status === "running"
                          ? `0 0 6px ${LEADER_HUES[colorIdx % LEADER_HUES.length].ring}`
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
                          ? "rgba(240,136,62,0.12)"
                          : "rgba(167,139,250,0.12)",
                      color:
                        agent.type === "leader" ? "#f0883e" : "#a78bfa",
                      flexShrink: 0,
                    }}
                  >
                    {agent.type === "leader" ? "LDR" : "MIN"}
                  </span>
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
                      color: "#a78bfa",
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
  { dot: "#fb923c", ring: "rgba(251,146,60,0.3)" },
  { dot: "#818cf8", ring: "rgba(129,140,248,0.3)" },
  { dot: "#34d399", ring: "rgba(52,211,153,0.3)" },
  { dot: "#f472b6", ring: "rgba(244,114,182,0.3)" },
  { dot: "#38bdf8", ring: "rgba(56,189,248,0.3)" },
  { dot: "#fbbf24", ring: "rgba(251,191,36,0.3)" },
  { dot: "#a78bfa", ring: "rgba(167,139,250,0.3)" },
  { dot: "#f87171", ring: "rgba(248,113,113,0.3)" },
];
