/**
 * ProjectTree — high-level working tree with leader activity overlays.
 *
 * Renders the project directory structure as a collapsible tree.
 * Each node shows colored pips for leaders actively touching files
 * within that subtree. Files show the specific leader(s) working on them.
 */

import { memo, useState, useMemo, useCallback, type CSSProperties, type ReactNode } from "react";
import type { TreeNode } from "../api.ts";
import { getAuthToken } from "../api.ts";
import { fuzzyMatch } from "../fuzzy-file-search.ts";

// ── Inline tooltip (CSS-only, no portal) ──

function Tooltip({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  const [show, setShow] = useState(false);
  return (
    <span
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      style={{ position: "relative", ...style }}
    >
      {children}
      {show && (
        <span
          style={{
            position: "absolute",
            left: "50%",
            bottom: "calc(100% + 4px)",
            transform: "translateX(-50%)",
            padding: "3px 7px",
            borderRadius: 4,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
            color: "var(--text-primary)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            boxShadow: "var(--shadow-sm)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 100,
            lineHeight: "14px",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

// ── Leader color palette — distinct, high-contrast hues ──

const LEADER_HUES = [
  { bg: "color-mix(in srgb, var(--priority-high) 14%, transparent)", dot: "var(--priority-high)", text: "var(--priority-high)", ring: "color-mix(in srgb, var(--priority-high) 30%, transparent)" },
  { bg: "color-mix(in srgb, var(--tool-accent) 14%, transparent)", dot: "var(--tool-accent)", text: "var(--tool-accent)", ring: "color-mix(in srgb, var(--tool-accent) 30%, transparent)" },
  { bg: "color-mix(in srgb, var(--status-success) 14%, transparent)", dot: "var(--status-success)", text: "var(--status-success)", ring: "color-mix(in srgb, var(--status-success) 30%, transparent)" },
  { bg: "color-mix(in srgb, var(--status-error) 14%, transparent)", dot: "var(--status-error)", text: "var(--status-error)", ring: "color-mix(in srgb, var(--status-error) 30%, transparent)" },
  { bg: "color-mix(in srgb, var(--streaming-color) 14%, transparent)", dot: "var(--streaming-color)", text: "var(--streaming-color)", ring: "color-mix(in srgb, var(--streaming-color) 30%, transparent)" },
  { bg: "color-mix(in srgb, var(--status-warning) 14%, transparent)", dot: "var(--status-warning)", text: "var(--status-warning)", ring: "color-mix(in srgb, var(--status-warning) 30%, transparent)" },
  { bg: "color-mix(in srgb, var(--status-waiting) 14%, transparent)", dot: "var(--status-waiting)", text: "var(--status-waiting)", ring: "color-mix(in srgb, var(--status-waiting) 30%, transparent)" },
  { bg: "color-mix(in srgb, var(--danger-color-text) 14%, transparent)", dot: "var(--danger-color-text)", text: "var(--danger-color-text)", ring: "color-mix(in srgb, var(--danger-color-text) 30%, transparent)" },
];

function getLeaderColor(index: number): (typeof LEADER_HUES)[number] {
  return LEADER_HUES[index % LEADER_HUES.length]!;
}

// ── File extension → icon mapping ──

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return "◇";
    case "js": case "jsx": return "◆";
    case "css": case "scss": return "◈";
    case "json": return "{}";
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
    case "ts": case "tsx": return "var(--priority-medium)";
    case "js": case "jsx": return "var(--status-warning)";
    case "css": case "scss": return "var(--thinking-accent)";
    case "json": return "var(--text-secondary)";
    case "md": return "var(--text-muted)";
    case "html": return "var(--priority-high)";
    default: return "var(--text-muted)";
  }
}

/** Tooltip label for file-type icons */
function fileIconTooltip(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": return "TypeScript";
    case "tsx": return "TypeScript (JSX)";
    case "js": return "JavaScript";
    case "jsx": return "JavaScript (JSX)";
    case "css": return "CSS Stylesheet";
    case "scss": return "SCSS Stylesheet";
    case "json": return "JSON";
    case "md": return "Markdown";
    case "html": return "HTML";
    case "svg": return "SVG Image";
    case "png": return "PNG Image";
    case "jpg": return "JPEG Image";
    case "gif": return "GIF Image";
    case "webp": return "WebP Image";
    case "sql": return "SQL";
    case "sh": case "bash": return "Shell Script";
    case "yaml": case "yml": return "YAML";
    case "toml": return "TOML";
    case "lock": return "Lock File";
    default: return ext ? `.${ext} file` : "File";
  }
}

function dirIconTooltip(expanded: boolean, hasActivity: boolean): string {
  const state = expanded ? "Expanded" : "Collapsed";
  return hasActivity ? `${state} folder (has agent activity)` : `${state} folder`;
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
  projectPath?: string | undefined;
  /** When true, only show paths with active leader work */
  filterActive?: boolean | undefined;
  /**
   * Fuzzy search query. When set, only nodes whose path matches (and their
   * ancestor directories) are rendered, and matched directories auto-expand.
   */
  query?: string | undefined;
  /** Called when the user clicks a file entry (relative path) */
  onFileClick?: ((relativePath: string) => void) | undefined;
  /** Called after a file/dir is moved or renamed (triggers tree refresh) */
  onTreeChanged?: (() => void) | undefined;
}

// ── Helpers ──

/** Build a map: relative path → set of leader indices that touch it */
function buildActivityMap(leaders: LeaderActivity[], projectPath?: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  // Normalize projectPath for prefix-stripping
  const prefix = projectPath ? (projectPath.endsWith("/") ? projectPath : projectPath + "/") : null;

  for (let i = 0; i < leaders.length; i++) {
    for (const filePath of leaders[i]!.files) {
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

/**
 * Walk the tree and collect every path that should remain visible under a
 * fuzzy search query. A node is visible if its own path matches, or if any
 * descendant's path matches (so ancestor directories pull their matching
 * children into view).
 *
 * Returns null when the query is empty — callers treat null as "no filter".
 */
function buildSearchMatch(tree: TreeNode[], query: string): Set<string> | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  const visible = new Set<string>();
  function walk(node: TreeNode): boolean {
    let descendantMatched = false;
    if (node.children) {
      for (const child of node.children) {
        if (walk(child)) descendantMatched = true;
      }
    }
    const selfMatch = fuzzyMatch(trimmed, node.path) !== null;
    if (selfMatch || descendantMatched) {
      visible.add(node.path);
      return true;
    }
    return false;
  }
  for (const root of tree) walk(root);
  return visible;
}

function collectDirectoryPaths(tree: TreeNode[]): string[] {
  const paths: string[] = [];
  function walk(node: TreeNode): void {
    if (node.type !== "dir") return;
    paths.push(node.path);
    for (const child of node.children ?? []) {
      walk(child);
    }
  }
  for (const root of tree) walk(root);
  return paths;
}

// ── Components ──

export const ProjectTree = memo(function ProjectTree({ tree, rootName, leaders, projectPath, filterActive = false, query = "", onFileClick, onTreeChanged }: ProjectTreeProps) {
  const activityMap = useMemo(() => buildActivityMap(leaders, projectPath), [leaders, projectPath]);
  const searchMatch = useMemo(() => buildSearchMatch(tree, query), [tree, query]);
  const directoryPaths = useMemo(() => collectDirectoryPaths(tree), [tree]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());

  const activeLeaders = leaders.filter(l => l.status === "running" || l.status === "creating");
  const allDirectoriesExpanded = directoryPaths.length > 0 && directoryPaths.every(path => expandedPaths.has(path));

  const handleToggleAllDirectories = useCallback(() => {
    setExpandedPaths(allDirectoriesExpanded ? new Set() : new Set(directoryPaths));
  }, [allDirectoriesExpanded, directoryPaths]);

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

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
        {directoryPaths.length > 0 && (
          <div
            style={{
              padding: "0 12px 6px",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={handleToggleAllDirectories}
              aria-label={allDirectoriesExpanded ? "Collapse all project folders" : "Expand all project folders"}
              style={{
                padding: "3px 8px",
                fontSize: 9,
                fontFamily: "var(--font-mono)",
                background: "transparent",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-muted)",
                cursor: "pointer",
                letterSpacing: 0.3,
                textTransform: "uppercase",
              }}
            >
              {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}

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
                color: "var(--status-success)",
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
            expandedPaths={expandedPaths}
            onToggleDirectory={handleToggleDirectory}
            filterActive={filterActive}
            searchMatch={searchMatch}
            onFileClick={onFileClick}
            projectPath={projectPath}
            onTreeChanged={onTreeChanged}
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
});

const TreeRow = memo(function TreeRow({
  node,
  depth,
  activityMap,
  leaders,
  expandedPaths,
  onToggleDirectory,
  filterActive,
  searchMatch,
  onFileClick,
  projectPath,
  onTreeChanged,
}: {
  node: TreeNode;
  depth: number;
  activityMap: Map<string, Set<number>>;
  leaders: LeaderActivity[];
  expandedPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  filterActive: boolean;
  searchMatch: Set<string> | null;
  onFileClick?: ((relativePath: string) => void) | undefined;
  projectPath?: string | undefined;
  onTreeChanged?: (() => void) | undefined;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const leaderIndices = activityMap.get(node.path);
  const isDirectlyTouched = leaderIndices && leaderIndices.size > 0;
  const hasChildActivity = node.type === "dir" && activityMap.has(node.path);

  // Visibility: combine the leader-activity filter with the search filter.
  // The decision is applied AFTER all hooks below so toggling filterActive
  // or typing in the search box can't change the hook count between renders
  // (React's rules-of-hooks invariant).
  const filteredOut =
    (filterActive && !isDirectlyTouched && !hasChildActivity) ||
    (searchMatch !== null && !searchMatch.has(node.path));

  const isDir = node.type === "dir";
  const expanded = isDir && expandedPaths.has(node.path);
  const indent = depth * 16;
  // While the user is searching, every directory we still render (i.e. one
  // that's in searchMatch) should be expanded so its matches are visible.
  const forceExpanded = isDir && searchMatch !== null;

  const handleRowClick = useCallback(() => {
    if (renaming) return;
    if (isDir) {
      onToggleDirectory(node.path);
    } else if (onFileClick) {
      onFileClick(node.path);
    }
  }, [isDir, onFileClick, node.path, onToggleDirectory, renaming]);

  // ── Drag source ──
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-tree-path", node.path);
    e.dataTransfer.setData("application/x-tree-type", node.type);
    e.dataTransfer.effectAllowed = "copyMove";
  }, [node.path, node.type]);

  // ── Drop target (directories only) ──
  const handleDragOverRow = useCallback((e: React.DragEvent) => {
    if (!isDir) return;
    if (!e.dataTransfer.types.includes("application/x-tree-path")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }, [isDir]);

  const handleDragLeaveRow = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDropOnRow = useCallback(async (e: React.DragEvent) => {
    setIsDragOver(false);
    if (!isDir || !projectPath) return;
    const fromPath = e.dataTransfer.getData("application/x-tree-path");
    if (!fromPath || fromPath === node.path) return;
    e.preventDefault();
    e.stopPropagation();

    // Compute destination: move into this directory
    const fileName = fromPath.split("/").pop() ?? fromPath;
    const toPath = node.path + "/" + fileName;
    if (fromPath === toPath) return;

    try {
      const token = await getAuthToken();
      const resp = await fetch("/api/files/move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath, fromPath, toPath }),
      });
      const json = await resp.json() as { ok?: boolean; error?: string };
      if (json.ok) {
        onTreeChanged?.();
      }
    } catch {
      // silently fail
    }
  }, [isDir, projectPath, node.path, onTreeChanged]);

  // ── Context menu ──
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!projectPath) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [projectPath]);

  const handleRename = useCallback(() => {
    setContextMenu(null);
    setRenameValue(node.name);
    setRenaming(true);
  }, [node.name]);

  const handleRenameSubmit = useCallback(async () => {
    setRenaming(false);
    if (!projectPath || !renameValue || renameValue === node.name) return;
    const parentDir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    const toPath = parentDir ? parentDir + "/" + renameValue : renameValue;
    try {
      const token = await getAuthToken();
      const resp = await fetch("/api/files/move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath, fromPath: node.path, toPath }),
      });
      const json = await resp.json() as { ok?: boolean };
      if (json.ok) onTreeChanged?.();
    } catch {
      // silently fail
    }
  }, [projectPath, renameValue, node.name, node.path, onTreeChanged]);

  const handleDelete = useCallback(async () => {
    setContextMenu(null);
    if (!projectPath) return;
    if (!window.confirm(`Delete "${node.name}"?`)) return;
    try {
      const token = await getAuthToken();
      const resp = await fetch("/api/files/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath, filePath: node.path }),
      });
      const json = await resp.json() as { ok?: boolean };
      if (json.ok) onTreeChanged?.();
    } catch {
      // silently fail
    }
  }, [projectPath, node.path, node.name, onTreeChanged]);

  const handleNewFolder = useCallback(async () => {
    setContextMenu(null);
    if (!projectPath || !isDir) return;
    const name = window.prompt("New folder name:");
    if (!name) return;
    try {
      const token = await getAuthToken();
      const resp = await fetch("/api/files/mkdir", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ projectPath, dirPath: node.path + "/" + name }),
      });
      const json = await resp.json() as { ok?: boolean };
      if (json.ok) onTreeChanged?.();
    } catch {
      // silently fail
    }
  }, [projectPath, isDir, node.path, onTreeChanged]);

  if (filteredOut) return null;

  // Determine if any touching leader is actively running
  const hasRunningLeader = leaderIndices
    ? [...leaderIndices].some(i => leaders[i]?.status === "running" || leaders[i]?.status === "creating")
    : false;

  // Background highlight for touched nodes
  const rowBg = isDirectlyTouched && node.type === "file"
    ? (() => {
        // Use the first leader's color as tint
        const firstIdx = [...leaderIndices!][0]!;
        const c = getLeaderColor(firstIdx);
        return c.bg;
      })()
    : "transparent";

  return (
    <>
      <div
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOverRow}
        onDragLeave={handleDragLeaveRow}
        onDrop={handleDropOnRow}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          padding: "3px 12px 3px 0",
          paddingLeft: indent,
          cursor: isDir || onFileClick ? "pointer" : "default",
          background: isDragOver ? "rgba(192, 132, 252, 0.12)" : rowBg,
          borderLeft: isDragOver
            ? "2px solid rgba(192, 132, 252, 0.6)"
            : isDirectlyTouched && node.type === "file"
              ? `2px solid ${getLeaderColor([...leaderIndices!][0]!).dot}`
              : "2px solid transparent",
          transition: "background 0.2s ease",
          userSelect: "none",
          position: "relative",
        }}
        onMouseEnter={(e) => {
          if (!isDragOver && (!isDirectlyTouched || node.type !== "file")) {
            e.currentTarget.style.background = "var(--bg-elevated)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isDragOver) {
            e.currentTarget.style.background = rowBg;
          }
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
              transform: (expanded || forceExpanded) ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▶
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}

        {/* Icon with tooltip */}
        <Tooltip
          label={isDir ? dirIconTooltip(expanded || forceExpanded, hasChildActivity) : fileIconTooltip(node.name)}
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
            cursor: "help",
          }}
        >
          {isDir ? ((expanded || forceExpanded) ? "▾" : "▸") : fileIcon(node.name)}
        </Tooltip>

        {/* Name */}
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--bg-elevated)",
              border: "1px solid var(--accent)",
              borderRadius: 3,
              color: "var(--text-primary)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              padding: "1px 4px",
              outline: "none",
            }}
          />
        ) : (
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
        )}

        {/* Leader activity tags */}
        {isDirectlyTouched && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexShrink: 0,
              marginLeft: 6,
            }}
          >
            {[...leaderIndices!].map((idx) => {
              const c = getLeaderColor(idx);
              const leader = leaders[idx];
              const isRunning = leader?.status === "running" || leader?.status === "creating";
              const label = leader?.name
                ? (leader.name.length > 12 ? leader.name.slice(0, 12) + "…" : leader.name)
                : null;
              return (
                <span
                  key={idx}
                  title={leader?.name ?? `Agent ${idx}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    padding: "0 4px",
                    borderRadius: 3,
                    background: c.bg,
                    border: `1px solid ${c.ring}`,
                    boxShadow: isRunning ? `0 0 6px ${c.ring}` : "none",
                    animation: isRunning ? "treeFlicker 1.5s ease-in-out infinite" : "none",
                    flexShrink: 0,
                    maxWidth: 100,
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: c.dot,
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  {label && (
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: "var(--font-mono)",
                        color: c.text,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        lineHeight: "14px",
                      }}
                    >
                      {label}
                    </span>
                  )}
                </span>
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

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 9998 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              boxShadow: "var(--shadow-md)",
              padding: "4px 0",
              zIndex: 9999,
              minWidth: 140,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
          >
            <div
              onClick={handleRename}
              style={{
                padding: "6px 12px",
                cursor: "pointer",
                color: "var(--text-secondary)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              Rename
            </div>
            {!isDir && (
              <div
                onClick={handleDelete}
                style={{
                  padding: "6px 12px",
                  cursor: "pointer",
                  color: "var(--danger-color)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                Delete
              </div>
            )}
            {isDir && (
              <div
                onClick={handleNewFolder}
                style={{
                  padding: "6px 12px",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                New folder
              </div>
            )}
          </div>
        </>
      )}

      {/* Children */}
      {isDir && (expanded || forceExpanded) && node.children && (
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
              expandedPaths={expandedPaths}
              onToggleDirectory={onToggleDirectory}
              filterActive={filterActive}
              searchMatch={searchMatch}
              onFileClick={onFileClick}
              projectPath={projectPath}
              onTreeChanged={onTreeChanged}
            />
          ))}
        </div>
      )}
    </>
  );
});
