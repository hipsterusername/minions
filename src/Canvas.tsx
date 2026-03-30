import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type Dispatch,
} from "react";
import type { CanvasTransform, CanvasNode, CanvasAction, Position, Size, ContextItem } from "./types.ts";
import { generateId } from "./canvas-state.ts";
import { CanvasNodeComponent } from "./CanvasNode.tsx";
import { getUserCreatableNodeTypes, getAllNodeTypes } from "./node-registry.ts";
import { SessionPanel } from "./SessionPanel.tsx";
import { EdgeRenderer } from "./EdgeRenderer.tsx";
import type { GraphDocument } from "./graph.ts";
import type { GraphAction } from "./graph-runtime.ts";
import { createEdge } from "./graph-runtime.ts";
import type { ClaudeSessionData } from "./nodes/ClaudeSessionNode.tsx";
import type { LeaderData, CompletedTask } from "./nodes/LeaderNode.tsx";
import type { MinionData, MinionTaskState } from "./nodes/MinionNode.tsx";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const GRID_SIZE = 24;

function DotGrid({ transform }: { transform: CanvasTransform }) {
  const dotSpacing = GRID_SIZE * transform.scale;
  const offsetX = (transform.x % dotSpacing + dotSpacing) % dotSpacing;
  const offsetY = (transform.y % dotSpacing + dotSpacing) % dotSpacing;

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <defs>
        <pattern
          id="dot-grid"
          width={dotSpacing}
          height={dotSpacing}
          patternUnits="userSpaceOnUse"
          x={offsetX}
          y={offsetY}
        >
          <circle
            cx={1}
            cy={1}
            r={1}
            fill="var(--dot-grid)"
            opacity={Math.min(1, transform.scale)}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  );
}

interface ToolbarProps {
  transform: CanvasTransform;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFitView: () => void;
  onAddNode: (type: string) => void;
}

function Toolbar({
  transform,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitView,
  onAddNode,
}: ToolbarProps) {
  const [showPalette, setShowPalette] = useState(false);
  const nodeTypes = getUserCreatableNodeTypes();

  const btnStyle: React.CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: 6,
    border: "1px solid var(--border-default)",
    background: "var(--bg-surface)",
    color: "var(--text-secondary)",
    fontSize: 14,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 4,
        padding: 6,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        zIndex: 100,
        alignItems: "center",
      }}
    >
      <div style={{ position: "relative" }}>
        <button
          style={{
            ...btnStyle,
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            fontWeight: 600,
          }}
          onClick={() => setShowPalette(!showPalette)}
          title="Add node"
        >
          +
        </button>
        {showPalette && (
          <div
            style={{
              position: "absolute",
              bottom: 42,
              left: 0,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-default)",
              borderRadius: 8,
              padding: 4,
              minWidth: 140,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            {nodeTypes.map((nt) => (
              <button
                key={nt.type}
                onClick={() => {
                  onAddNode(nt.type);
                  setShowPalette(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px 12px",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-primary)",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "left",
                  borderRadius: 4,
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--bg-elevated)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                {nt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          width: 1,
          height: 20,
          background: "var(--border-default)",
          margin: "0 4px",
        }}
      />

      <button style={btnStyle} onClick={onZoomOut} title="Zoom out">
        -
      </button>
      <button
        style={{
          ...btnStyle,
          width: "auto",
          padding: "0 8px",
          fontSize: 11,
        }}
        onClick={onZoomReset}
        title="Reset zoom"
      >
        {Math.round(transform.scale * 100)}%
      </button>
      <button style={btnStyle} onClick={onZoomIn} title="Zoom in">
        +
      </button>
      <button
        style={{ ...btnStyle, fontSize: 11 }}
        onClick={onFitView}
        title="Fit view"
      >
        []
      </button>
    </div>
  );
}

/** Find a position for a new node that doesn't overlap existing nodes */
function findNonOverlappingPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  existingNodes: CanvasNode[],
): Position {
  let cx = x;
  let cy = y;
  let attempts = 0;
  while (attempts < 20) {
    const overlaps = existingNodes.some(
      (n) =>
        !(
          cx > n.position.x + n.size.width ||
          cx + w < n.position.x ||
          cy > n.position.y + n.size.height ||
          cy + h < n.position.y
        ),
    );
    if (!overlaps) break;
    cx += 30;
    cy += 30;
    attempts++;
  }
  return { x: cx, y: cy };
}

interface CanvasProps {
  nodes: CanvasNode[];
  dispatch: Dispatch<CanvasAction>;
  graph: GraphDocument;
  graphDispatch: Dispatch<GraphAction>;
  transform: CanvasTransform;
  setTransform: React.Dispatch<React.SetStateAction<CanvasTransform>>;
  socketSend?: (data: unknown) => void;
  socketSubscribe?: (fn: (msg: unknown) => void) => () => void;
  socketConnected?: boolean;
  projectPath?: string;
  undo?: () => void;
  redo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** When set, auto-selects this node (then clear it) */
  focusNodeId?: string | null;
  onFocusNodeHandled?: () => void;
}

export function Canvas({
  nodes,
  dispatch,
  graph,
  graphDispatch,
  transform,
  setTransform,
  socketSend,
  socketSubscribe,
  socketConnected,
  projectPath,
  undo,
  redo,
  canUndo,
  canRedo,
  focusNodeId,
  onFocusNodeHandled,
}: CanvasProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isPanning, setIsPanning] = useState(false);

  // Handle external focus-node requests
  useEffect(() => {
    if (!focusNodeId) return;
    setSelectedIds(new Set([focusNodeId]));
    onFocusNodeHandled?.();
  }, [focusNodeId, onFocusNodeHandled]);

  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ startX: number; startY: number } | null>(null);
  const spaceRef = useRef(false);

  // Keep a ref to nodes so WS event handlers can access latest state
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Track space key for pan mode, delete, and undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        spaceRef.current = true;
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        for (const id of selectedIds) {
          dispatch({ type: "REMOVE_NODE", id });
          graphDispatch({ type: "REMOVE_EDGES_FOR_NODE", nodeId: id });
        }
        setSelectedIds(new Set());
      }

      // Undo/Redo: Ctrl+Z / Cmd+Z and Ctrl+Shift+Z / Ctrl+Y / Cmd+Shift+Z
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) {
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        undo?.();
      }
      if (
        (mod && e.key === "z" && e.shiftKey) ||
        (mod && e.key === "y")
      ) {
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        redo?.();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [selectedIds, dispatch, graphDispatch, undo, redo]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setTransform((prev) => {
      const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08;
      const newScale = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, prev.scale * zoomFactor),
      );
      const scaleChange = newScale / prev.scale;
      return {
        x: mouseX - (mouseX - prev.x) * scaleChange,
        y: mouseY - (mouseY - prev.y) * scaleChange,
        scale: newScale,
      };
    });
  }, [setTransform]);

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
        e.preventDefault();
        setIsPanning(true);
        panRef.current = { startX: e.clientX, startY: e.clientY };

        const handleMouseMove = (ev: MouseEvent) => {
          if (!panRef.current) return;
          const dx = ev.clientX - panRef.current.startX;
          const dy = ev.clientY - panRef.current.startY;
          panRef.current = { startX: ev.clientX, startY: ev.clientY };
          setTransform((prev) => ({
            ...prev,
            x: prev.x + dx,
            y: prev.y + dy,
          }));
        };

        const handleMouseUp = () => {
          panRef.current = null;
          setIsPanning(false);
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        return;
      }

      if (e.button === 0 && e.target === e.currentTarget) {
        setSelectedIds(new Set());
      }
    },
    [setTransform],
  );

  const handleSelectNode = useCallback(
    (id: string, additive: boolean) => {
      setSelectedIds((prev) => {
        if (additive) {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        }
        if (prev.has(id) && prev.size === 1) return prev;
        return new Set([id]);
      });
    },
    [],
  );

  const handleMoveNode = useCallback(
    (id: string, position: Position) => {
      const currentNode = nodesRef.current.find((n) => n.id === id);
      if (currentNode && currentNode.type === "leader") {
        const dx = position.x - currentNode.position.x;
        const dy = position.y - currentNode.position.y;
        const minions = nodesRef.current.filter(
          (n) =>
            n.type === "minion" &&
            (n.data as MinionData).leaderId === currentNode.id,
        );
        const moves = [
          { id, position },
          ...minions.map((m) => ({
            id: m.id,
            position: { x: m.position.x + dx, y: m.position.y + dy },
          })),
        ];
        dispatch({ type: "MOVE_GROUP", moves });
      } else {
        dispatch({ type: "MOVE_NODE", id, position });
      }
    },
    [dispatch],
  );

  const handleUpdateNodeData = useCallback(
    (id: string, data: unknown) => {
      dispatch({ type: "UPDATE_NODE_DATA", id, data });
    },
    [dispatch],
  );

  const handleResizeNode = useCallback(
    (id: string, size: Size) => {
      dispatch({ type: "RESIZE_NODE", id, size });
    },
    [dispatch],
  );

  const addNode = useCallback(
    (type: string) => {
      const allTypes = getAllNodeTypes();
      const typeDef = allTypes.find((t) => t.type === type);
      if (!typeDef) return;

      const container = containerRef.current;
      const centerX = container
        ? (container.clientWidth / 2 - transform.x) / transform.scale
        : 400;
      const centerY = container
        ? (container.clientHeight / 2 - transform.y) / transform.scale
        : 300;

      let defaultData: unknown = {};
      if (type === "note") {
        defaultData = { text: "", color: "#1a2744" };
      } else if (type === "claude-session") {
        defaultData = {
          sessionKey: null,
          status: "disconnected",
          messages: [],
          streamingText: "",
          totalCost: 0,
          turns: 0,
          error: null,
          model: "sonnet",
          permissionMode: "bypassPermissions",
          modelUsage: null,
          lastDurationMs: null,
          subagents: [],
          promptSuggestions: [],
          initData: null,
        };
      } else if (type === "leader") {
        defaultData = {
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
      } else if (type === "minion") {
        defaultData = {
          sessionKey: null,
          status: "waiting",
          leaderId: null,
          taskQueue: [],
          activeTaskIndex: -1,
          messages: [],
          streamingText: "",
          totalCost: 0,
          turns: 0,
          error: null,
          model: "sonnet",
          permissionMode: "bypassPermissions",
        };
      } else if (type === "markdown") {
        defaultData = { title: "Untitled", content: "", viewMode: "edit" };
      }

      const rawX = centerX - typeDef.defaultSize.width / 2;
      const rawY = centerY - typeDef.defaultSize.height / 2;
      const position = findNonOverlappingPosition(
        rawX,
        rawY,
        typeDef.defaultSize.width,
        typeDef.defaultSize.height,
        nodes,
      );

      const node: CanvasNode = {
        id: generateId(),
        type,
        position,
        size: { ...typeDef.defaultSize },
        data: defaultData,
      };
      dispatch({ type: "ADD_NODE", node });
      setSelectedIds(new Set([node.id]));
    },
    [transform, dispatch, nodes],
  );

  const zoomTo = useCallback(
    (newScale: number) => {
      const container = containerRef.current;
      if (!container) return;
      const cx = container.clientWidth / 2;
      const cy = container.clientHeight / 2;
      setTransform((prev) => {
        const clamped = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, newScale),
        );
        const scaleChange = clamped / prev.scale;
        return {
          x: cx - (cx - prev.x) * scaleChange,
          y: cy - (cy - prev.y) * scaleChange,
          scale: clamped,
        };
      });
    },
    [setTransform],
  );

  const fitView = useCallback(() => {
    if (nodes.length === 0) {
      setTransform({ x: 0, y: 0, scale: 1 });
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + n.size.width);
      maxY = Math.max(maxY, n.position.y + n.size.height);
    }

    const padding = 60;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const scaleX = container.clientWidth / contentW;
    const scaleY = container.clientHeight / contentH;
    const scale = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(scaleX, scaleY)),
    );

    setTransform({
      x:
        container.clientWidth / 2 -
        ((minX + maxX) / 2) * scale,
      y:
        container.clientHeight / 2 -
        ((minY + maxY) / 2) * scale,
      scale,
    });
  }, [nodes, setTransform]);

  // ── Handle server-side minion_spawned + agent_spawned events ──
  // When the Leader's assign_task MCP tool fires, it broadcasts a
  // `minion_spawned` event. When the SDK's built-in Agent tool spawns
  // a subagent, the server broadcasts an `agent_spawned` event.
  // Both create corresponding minion nodes + edges on the canvas.
  const spawnedMinionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!socketSubscribe) return;
    return socketSubscribe((msg: unknown) => {
      const serverMsg = msg as { type: string; [key: string]: unknown };

      // ── MCP assign_task → minion_spawned ──
      if (serverMsg.type === "minion_spawned") {
        const {
          leaderSessionKey,
          minionSessionKey,
          taskId,
          title,
          description,
          priority,
          worktreeBranch,
        } = serverMsg as {
          leaderSessionKey: string;
          minionSessionKey: string;
          taskId: string;
          title: string;
          description: string;
          priority: "low" | "medium" | "high" | "critical";
          worktreeBranch?: string | null;
        };

        // Dedup — don't create the same minion twice
        if (spawnedMinionsRef.current.has(minionSessionKey)) return;
        spawnedMinionsRef.current.add(minionSessionKey);

        // Find the leader node by session key
        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) {
          console.warn(`[Canvas] minion_spawned: leader session ${leaderSessionKey} not found on canvas`);
          return;
        }

        // Count existing minions for positioning
        const existingMinions = nodesRef.current.filter(
          (n) => n.type === "minion" && (n.data as MinionData).leaderId === leader.id,
        );
        const minionTypeDef = getAllNodeTypes().find((t) => t.type === "minion");
        if (!minionTypeDef) return;

        const minionCount = existingMinions.length;

        // Multi-column grid layout for minions
        const GAP_X = 60;
        const GAP_Y = 16;
        const MINIONS_PER_COLUMN = 4;
        const minionHeight = minionTypeDef.defaultSize.height;
        const minionWidth = minionTypeDef.defaultSize.width;

        const col = Math.floor(minionCount / MINIONS_PER_COLUMN);
        const row = minionCount % MINIONS_PER_COLUMN;

        const minionId = generateId();
        const minionX = leader.position.x + leader.size.width + GAP_X + col * (minionWidth + GAP_X);
        const minionY = leader.position.y + row * (minionHeight + GAP_Y);

        const taskState: MinionTaskState = {
          taskId,
          title,
          description,
          priority,
          status: "in_progress",
          activeStep: null,
          progress: [],
          result: null,
        };

        const minionData: MinionData = {
          sessionKey: minionSessionKey,
          status: "running",
          leaderId: leader.id,
          taskQueue: [taskState],
          activeTaskIndex: 0,
          messages: [
            {
              id: `auto-${Date.now()}`,
              role: "user" as const,
              content: `Starting task: ${title}`,
              timestamp: Date.now(),
            },
          ],
          streamingText: "",
          totalCost: 0,
          turns: 0,
          error: null,
          model: "sonnet" as const,
          permissionMode: "bypassPermissions" as const,
          worktreeBranch: worktreeBranch ?? null,
        };

        const newNode: CanvasNode = {
          id: minionId,
          type: "minion",
          position: { x: minionX, y: minionY },
          size: { ...minionTypeDef.defaultSize },
          data: minionData,
        };

        dispatch({ type: "ADD_NODE", node: newNode });

        const edge = createEdge(
          leader.id, "task-out", "leader",
          minionId, "task-in", "minion",
        );
        if (edge) graphDispatch({ type: "ADD_EDGE", edge: edge });

        console.log(`[Canvas] Minion spawned: ${minionSessionKey} for task "${title}" (${taskId})`);
        return;
      }

      // ── SDK Agent tool → agent_spawned ──
      if (serverMsg.type === "agent_spawned") {
        const {
          leaderSessionKey,
          taskId,
          title,
          description,
        } = serverMsg as {
          leaderSessionKey: string;
          taskId: string;
          title: string;
          description: string;
        };

        // Dedup by taskId
        const dedupKey = `agent-${taskId}`;
        if (spawnedMinionsRef.current.has(dedupKey)) return;
        spawnedMinionsRef.current.add(dedupKey);

        // Find the leader node by session key
        const leader = nodesRef.current.find(
          (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === leaderSessionKey,
        );
        if (!leader) {
          console.warn(`[Canvas] agent_spawned: leader session ${leaderSessionKey} not found on canvas`);
          return;
        }

        // Count existing minions for positioning
        const existingMinions = nodesRef.current.filter(
          (n) => n.type === "minion" && (n.data as MinionData).leaderId === leader.id,
        );
        const minionTypeDef = getAllNodeTypes().find((t) => t.type === "minion");
        if (!minionTypeDef) return;

        const minionCount = existingMinions.length;

        // Multi-column grid layout for minions
        const GAP_X = 60;
        const GAP_Y = 16;
        const MINIONS_PER_COLUMN = 4;
        const minionHeight = minionTypeDef.defaultSize.height;
        const minionWidth = minionTypeDef.defaultSize.width;

        const col = Math.floor(minionCount / MINIONS_PER_COLUMN);
        const row = minionCount % MINIONS_PER_COLUMN;

        const minionId = generateId();
        const minionX = leader.position.x + leader.size.width + GAP_X + col * (minionWidth + GAP_X);
        const minionY = leader.position.y + row * (minionHeight + GAP_Y);

        const taskState: MinionTaskState = {
          taskId,
          title: title ?? description,
          description: description ?? title,
          priority: "medium",
          status: "in_progress",
          activeStep: null,
          progress: [],
          result: null,
        };

        // Agent-tool subagent: no independent session, status comes
        // from the parent session's task_notification events
        const minionData: MinionData = {
          sessionKey: null,
          status: "running",
          leaderId: leader.id,
          taskQueue: [taskState],
          activeTaskIndex: 0,
          messages: [
            {
              id: `auto-${Date.now()}`,
              role: "user" as const,
              content: `Subagent: ${title}`,
              timestamp: Date.now(),
            },
          ],
          streamingText: "",
          totalCost: 0,
          turns: 0,
          error: null,
          model: "sonnet" as const,
          permissionMode: "bypassPermissions" as const,
          agentTaskId: taskId,
          parentSessionKey: leaderSessionKey,
        };

        const newNode: CanvasNode = {
          id: minionId,
          type: "minion",
          position: { x: minionX, y: minionY },
          size: { ...minionTypeDef.defaultSize },
          data: minionData,
        };

        dispatch({ type: "ADD_NODE", node: newNode });

        const edge = createEdge(
          leader.id, "task-out", "leader",
          minionId, "task-in", "minion",
        );
        if (edge) graphDispatch({ type: "ADD_EDGE", edge: edge });

        console.log(`[Canvas] Agent subagent spawned for task "${title}" (${taskId})`);
        return;
      }
    });
  }, [socketSubscribe, dispatch, graphDispatch]);

  // ── Auto-close completed minions → push to leader task tracker ──
  useEffect(() => {
    const closingMinions = new Set<string>();

    const checkInterval = setInterval(() => {
      const currentNodes = nodesRef.current;

      for (const node of currentNodes) {
        if (node.type !== "minion") continue;
        if (closingMinions.has(node.id)) continue;

        const minionData = node.data as MinionData;

        const hasCompletedTask = minionData.taskQueue.some(
          (t) => t.status === "completed" || t.status === "failed",
        );
        const isFinished =
          minionData.status === "idle" ||
          minionData.status === "stopped" ||
          minionData.status === "error";

        if (!hasCompletedTask || !isFinished) continue;
        if (!minionData.leaderId) continue;

        const leader = currentNodes.find((n) => n.id === minionData.leaderId);
        if (!leader) continue;

        closingMinions.add(node.id);

        // Delay removal so user sees completion briefly
        setTimeout(() => {
          const latestNodes = nodesRef.current;
          const latestMinion = latestNodes.find((n) => n.id === node.id);
          if (!latestMinion) return;

          const latestMinionData = latestMinion.data as MinionData;
          const latestLeader = latestNodes.find(
            (n) => n.id === minionData.leaderId,
          );
          if (!latestLeader) return;

          const leaderData = latestLeader.data as LeaderData;

          const newCompletedTasks: CompletedTask[] = latestMinionData.taskQueue
            .filter((t) => t.status === "completed" || t.status === "failed")
            .map((t) => ({
              taskId: t.taskId,
              title: t.title,
              description: t.description,
              priority: t.priority,
              result: t.result,
              completedAt: Date.now(),
              cost: latestMinionData.totalCost,
              sessionKey: latestMinionData.sessionKey,
              sessionSummary: latestMinionData.messages
                .filter(
                  (m) => m.role === "assistant" || m.role === "result",
                )
                .slice(-3)
                .map((m) => m.content)
                .join("\n")
                .slice(0, 500),
            }));

          // Update leader's completedTasks
          dispatch({
            type: "UPDATE_NODE_DATA",
            id: latestLeader.id,
            data: {
              ...leaderData,
              completedTasks: [
                ...(leaderData.completedTasks ?? []),
                ...newCompletedTasks,
              ],
            },
          });

          // Remove minion node and its edges
          dispatch({ type: "REMOVE_NODE", id: node.id });
          graphDispatch({ type: "REMOVE_EDGES_FOR_NODE", nodeId: node.id });

          console.log(
            `[Canvas] Minion ${node.id} closed — ${newCompletedTasks.length} task(s) moved to leader tracker`,
          );
        }, 2000);
      }
    }, 1000);

    return () => clearInterval(checkInterval);
  }, [dispatch, graphDispatch]);

  // Compute which session keys are already on the canvas
  const attachedSessionKeys = new Set(
    nodes
      .filter((n) => n.type === "claude-session")
      .map((n) => (n.data as ClaudeSessionData).sessionKey)
      .filter((k): k is string => k !== null),
  );

  // Attach a backend session to the canvas by creating a node for it
  const handleAttachSession = useCallback(
    (sessionKey: string) => {
      const typeDef = getAllNodeTypes().find((t) => t.type === "claude-session");
      if (!typeDef) return;

      const container = containerRef.current;
      const centerX = container
        ? (container.clientWidth / 2 - transform.x) / transform.scale
        : 400;
      const centerY = container
        ? (container.clientHeight / 2 - transform.y) / transform.scale
        : 300;

      const sessionData: ClaudeSessionData = {
        sessionKey,
        status: "idle",
        messages: [],
        streamingText: "",
        totalCost: 0,
        turns: 0,
        error: null,
      };

      dispatch({
        type: "ADD_NODE",
        node: {
          id: generateId(),
          type: "claude-session",
          position: {
            x: centerX - typeDef.defaultSize.width / 2,
            y: centerY - typeDef.defaultSize.height / 2,
          },
          size: { ...typeDef.defaultSize },
          data: sessionData,
        },
      });
    },
    [transform, dispatch],
  );

  const getContextForNode = useCallback((nodeId: string): ContextItem[] => {
    const contextEdges = graph.edges.filter(
      (e) => e.targetNodeId === nodeId && e.protocol === "context",
    );

    const items: ContextItem[] = [];
    for (const edge of contextEdges) {
      const sourceNode = nodes.find((n) => n.id === edge.sourceNodeId);
      if (!sourceNode) continue;

      let content = "";
      let label = "";

      if (sourceNode.type === "note") {
        const noteData = sourceNode.data as { text: string; color: string };
        content = noteData.text;
        label = "Note";
      } else if (sourceNode.type === "markdown") {
        const mdData = sourceNode.data as { title: string; content: string; viewMode: string };
        content = mdData.content;
        label = mdData.title || "Markdown";
      }

      if (content.trim()) {
        items.push({
          nodeId: sourceNode.id,
          nodeType: sourceNode.type,
          label,
          content,
        });
      }
    }
    return items;
  }, [nodes, graph]);

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleCanvasMouseDown}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        cursor: isPanning
          ? "grabbing"
          : spaceRef.current
            ? "grab"
            : "default",
      }}
    >
      <DotGrid transform={transform} />

      <SessionPanel
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
        socketConnected={socketConnected}
        onAttachSession={handleAttachSession}
        attachedSessionKeys={attachedSessionKeys}
      />

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          willChange: "transform",
        }}
      >
        {nodes.map((node) => (
          <CanvasNodeComponent
            key={node.id}
            node={node}
            transform={transform}
            isSelected={selectedIds.has(node.id)}
            onSelect={handleSelectNode}
            onMove={handleMoveNode}
            onUpdateData={handleUpdateNodeData}
            onResize={handleResizeNode}
            socketSend={socketSend}
            socketSubscribe={socketSubscribe}
            getContextForNode={() => getContextForNode(node.id)}
            projectPath={projectPath}
          />
        ))}
      </div>

      <EdgeRenderer graph={graph} nodes={nodes} transform={transform} />

      {/* Connection indicator */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 16,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          zIndex: 100,
        }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: socketConnected ? "#4ade80" : "#ef4444",
            boxShadow: socketConnected ? "0 0 6px #4ade80" : "none",
          }}
        />
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          {socketConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <Toolbar
        transform={transform}
        onZoomIn={() => zoomTo(transform.scale * 1.25)}
        onZoomOut={() => zoomTo(transform.scale * 0.8)}
        onZoomReset={() =>
          setTransform((p) => ({
            ...p,
            scale: 1,
            x:
              containerRef.current
                ? containerRef.current.clientWidth / 2 -
                  (containerRef.current.clientWidth / 2 - p.x) /
                    p.scale
                : 0,
            y:
              containerRef.current
                ? containerRef.current.clientHeight / 2 -
                  (containerRef.current.clientHeight / 2 - p.y) /
                    p.scale
                : 0,
          }))
        }
        onFitView={fitView}
        onAddNode={addNode}
      />
    </div>
  );
}
