/**
 * ProjectTree — high-level working tree with leader activity overlays.
 *
 * Renders the project directory structure as a collapsible tree.
 * Each node shows colored pips for leaders actively touching files
 * within that subtree. Files show the specific leader(s) working on them.
 */

import { useState, useMemo, useCallback } from "react";
import type { TreeNode } from "../api.ts";

// ── Leader color palette — distinct, high-contrast hues ──

const LEADER_HUES = [
  { bg: "rgba(251,146,60,0.14)", dot: "#fb923c", text: "#fb923c", ring: "rgba(251,146,60,0.3)" },   // amber
  { bg: "rgba(129,140,248,0.14)", dot: "#818cf8", text: "#818cf8", ring: "rgba(129,140,248,0.3)" },  // indigo
  { bg: "rgba(52,211,153,0.14)", dot: "#34d399", text: "#34d399", ring: "rgba(52,211,153,0.3)" },    // emerald
  { bg: "rgba(244,114,182,0.14)", dot: "#f472b6", text: "#f472b6", ring: "rgba(244,114,182,0.3)" },  // pink
  { bg: "rgba(56,189,248,0.14)", dot: "#38bdf8", text: "#38bdf8", ring: "rgba(56,189,248,0.3)" },    // sky
  { bg: "rgba(251,191,36,0.14)", dot: "#fbbf24", text: "#fbbf24", ring: "rgba(251,191,36,0.3)" },    // yellow
  { bg: "rgba(167,139,250,0.14)", dot: "#a78bfa", text: "#a78bfa", ring: "rgba(167,139,250,0.3)" },  // violet
  { bg: "rgba(248,113,113,0.14)", dot: "#f87171", text: "#f87171", ring: "rgba(248,113,113,0.3)" },  // red
];

function getLeaderColor(index: number) {
  return LEADER_HUES[index % LEADER_HUES.length];
}

// ── File extension → icon mapping ──

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return "◇";
    case "js": case "jsx": return "◆";
    case "css": case "scss": return "◈";
    case "json": return "{ }";
    case "md": return "¶";
    case "html": return "◁";
    case "svg": return "△";
    case "png": case "jpg": case "gif": case "webp": return "▣";
    case "sql": return "⊞";
    case "sh": case "bash": return "$";
    case "yaml": case "yml": return "≡";
    case "toml": return "⊟";
    case "lock": return "⊘";
    default: return "·";
  }
}

function fileIconColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return "#3b82f6";
    case "js": case "jsx": return "#eab308";
    case "css": case "scss": return "#c084fc";
    case "json": return "#a3a3a3";
    case "md": return "#737373";
    case "html": return "#f97316";
    default: return "var(--text-muted)";
  }
}

// ── Types ──

export interface LeaderActivity {
  id: string;
  name: string;
  colorIndex: number;
  status: "running" | "idle" | "creating" | "stopped" | "error" | "disconnected";
  /** Relative file paths this leader has touched */
  files: string[];
}

interface ProjectTreeProps {
  tree: TreeNode[];
  rootName: string;
  leaders: LeaderActivity[];
  /** Absolute project root path — used to normalize absolute file paths */
  projectPath?: string;
  /** When true, only show paths with active leader work */
  filterActive?: boolean;
}

// ── Helpers ──

/** Build a map: relative path → set of leader indices that touch it */
function buildActivityMap(leaders: LeaderActivity[], projectPath?: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  // Normalize projectPath for prefix-stripping
  const prefix = projectPath ? (projectPath.endsWith("/") ? projectPath : projectPath + "/") : null;

  for (let i = 0; i < leaders.length; i++) {
    for (const filePath of leaders[i].files) {
      let normalized = filePath;
      // Strip absolute project path prefix if present
      if (prefix && normalized.startsWith(prefix)) {
        normalized = normalized.slice(prefix.length);
      }
      // Also strip leading ./ or /
      normalized = normalized.replace(/^\.\//, "").replace(/^\//, "");
      if (!normalized) continue;

      // Add the file itself
      if (!map.has(normalized)) map.set(normalized, new Set());
      map.get(normalized)!.add(i);
      // Add all parent directories
      const parts = normalized.split("/");
      for (let j = 1; j < parts.length; j++) {
        const ancestor = parts.slice(0, j).join("/");
        if (!map.has(ancestor)) map.set(ancestor, new Set());
        map.get(ancestor)!.add(i);
      }
    }
  }
  return map;
}

/** Check if a tree node or any descendant has activity */
function hasActivity(node: TreeNode, activityMap: Map<string, Set<number>>): boolean {
  if (activityMap.has(node.path)) return true;
  if (node.children) {
    return node.children.some(c => hasActivity(c, activityMap));
  }
  return false;
}

// ── Components ──

export function ProjectTree({ tree, rootName, leaders, projectPath, filterActive = false }: ProjectTreeProps) {
  const activityMap = useMemo(() => buildActivityMap(leaders, projectPath), [leaders, projectPath]);

  const activeLeaders = leaders.filter(l => l.status === "running" || l.status === "creating");

  return (
    <div style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
      {/* Legend: leader names with color pips */}
      {leaders.length > 0 && (
        <div
          style={{
            padding: "10px 12px 8px",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 12px",
          }}
        >
          {leaders.map((leader) => {
            const c = getLeaderColor(leader.colorIndex);
            const isActive = leader.status === "running" || leader.status === "creating";
            return (
              <div
                key={leader.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  opacity: isActive ? 1 : 0.45,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: c.dot,
                    boxShadow: isActive ? `0 0 8px ${c.ring}` : "none",
                    display: "inline-block",
                    flexShrink: 0,
                    transition: "box-shadow 0.3s ease",
                  }}
                />
                <span
                  style={{
                    color: isActive ? c.text : "var(--text-muted)",
                    fontSize: 10,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 100,
                    transition: "color 0.3s ease",
                  }}
                >
                  {leader.name}
                </span>
                {leader.files.length > 0 && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
                      opacity: 0.7,
                    }}
                  >
                    {leader.files.length}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Tree */}
      <div style={{ padding: "6px 0" }}>
        {/* Root */}
        <div
          style={{
            padding: "4px 12px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text-secondary)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 0.2,
          }}
        >
          <span style={{ color: "var(--accent)", fontSize: 12 }}>⊡</span>
          {rootName}
          {activeLeaders.length > 0 && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: 9,
                color: "#34d399",
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
                  boxShadow: "0 0 6px rgba(52,211,153,0.5)",
                  display: "inline-block",
                  animation: "treePulse 2s ease-in-out infinite",
                }}
              />
              {activeLeaders.length} active
            </span>
          )}
        </div>

        {/* Children */}
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={1}
            activityMap={activityMap}
            leaders={leaders}
            filterActive={filterActive}
          />
        ))}
      </div>

      {/* Inject keyframes */}
      <style>{`
        @keyframes treePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes treeFlicker {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  activityMap,
  leaders,
  filterActive,
}: {
  node: TreeNode;
  depth: number;
  activityMap: Map<string, Set<number>>;
  leaders: LeaderActivity[];
  filterActive: boolean;
}) {
  const [expanded, setExpanded] = useState(() => {
    // Auto-expand directories that have activity
    if (node.type === "dir" && hasActivity(node, activityMap)) return true;
    // Auto-expand first level
    if (depth <= 1) return true;
    return false;
  });

  const leaderIndices = activityMap.get(node.path);
  const isDirectlyTouched = leaderIndices && leaderIndices.size > 0;
  const hasChildActivity = node.type === "dir" && hasActivity(node, activityMap);

  // Filter mode: skip nodes without activity
  if (filterActive && !isDirectlyTouched && !hasChildActivity) return null;

  const isDir = node.type === "dir";
  const indent = depth * 16;

  const toggleExpand = useCallback(() => {
    if (isDir) setExpanded(e => !e);
  }, [isDir]);

  // Determine if any touching leader is actively running
  const hasRunningLeader = leaderIndices
    ? [...leaderIndices].some(i => leaders[i]?.status === "running" || leaders[i]?.status === "creating")
    : false;

  // Background highlight for touched nodes
  const rowBg = isDirectlyTouched && node.type === "file"
    ? (() => {
        // Use the first leader's color as tint
        const firstIdx = [...leaderIndices!][0];
        const c = getLeaderColor(firstIdx);
        return c.bg;
      })()
    : "transparent";

  return (
    <>
      <div
        onClick={toggleExpand}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          padding: "3px 12px 3px 0",
          paddingLeft: indent,
          cursor: isDir ? "pointer" : "default",
          background: rowBg,
          borderLeft: isDirectlyTouched && node.type === "file"
            ? `2px solid ${getLeaderColor([...leaderIndices!][0]).dot}`
            : "2px solid transparent",
          transition: "background 0.2s ease",
          userSelect: "none",
          position: "relative",
        }}
        onMouseEnter={(e) => {
          if (!isDirectlyTouched || node.type !== "file") {
            e.currentTarget.style.background = "var(--bg-elevated)";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = rowBg;
        }}
      >
        {/* Expand/collapse chevron for dirs */}
        {isDir ? (
          <span
            style={{
              width: 14,
              fontSize: 8,
              color: hasChildActivity ? "var(--text-secondary)" : "var(--text-muted)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "transform 0.15s ease",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▶
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}

        {/* Icon */}
        <span
          style={{
            width: 16,
            fontSize: isDir ? 10 : 11,
            color: isDir
              ? (hasChildActivity ? "var(--accent)" : "var(--text-muted)")
              : fileIconColor(node.name),
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontWeight: isDir ? 600 : 400,
          }}
        >
          {isDir ? (expanded ? "▾" : "▸") : fileIcon(node.name)}
        </span>

        {/* Name */}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: isDirectlyTouched
              ? "var(--text-primary)"
              : (isDir && hasChildActivity)
                ? "var(--text-secondary)"
                : "var(--text-muted)",
            fontWeight: isDir ? 500 : 400,
            fontSize: 11,
            letterSpacing: isDir ? 0.2 : 0,
            transition: "color 0.2s ease",
          }}
        >
          {node.name}
        </span>

        {/* Leader activity pips */}
        {isDirectlyTouched && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              marginLeft: 6,
            }}
          >
            {[...leaderIndices!].map((idx) => {
              const c = getLeaderColor(idx);
              const isRunning = leaders[idx]?.status === "running" || leaders[idx]?.status === "creating";
              return (
                <span
                  key={idx}
                  title={leaders[idx]?.name}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: c.dot,
                    boxShadow: isRunning ? `0 0 6px ${c.ring}` : "none",
                    display: "inline-block",
                    flexShrink: 0,
                    animation: isRunning ? "treeFlicker 1.5s ease-in-out infinite" : "none",
                  }}
                />
              );
            })}
          </span>
        )}

        {/* Running indicator for dirs with active children */}
        {isDir && hasRunningLeader && !isDirectlyTouched && (
          <span
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: "var(--accent)",
              opacity: 0.5,
              flexShrink: 0,
              marginLeft: 6,
              animation: "treePulse 2s ease-in-out infinite",
            }}
          />
        )}
      </div>

      {/* Children */}
      {isDir && expanded && node.children && (
        <div
          style={{
            borderLeft: depth > 0 ? "1px solid var(--border-default)" : "none",
            marginLeft: indent + 6,
          }}
        >
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activityMap={activityMap}
              leaders={leaders}
              filterActive={filterActive}
            />
          ))}
        </div>
      )}
    </>
  );
}
