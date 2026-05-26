import "./nodes/ClaudeSessionNode.tsx";
import "./nodes/LeaderNode.tsx";
import "./nodes/MinionNode.tsx";
import "./nodes/MarkdownNode.tsx";
import "./nodes/FileViewerNode.tsx";
import "./nodes/FolderNode.tsx";
import "./nodes/ContextGroupNode.tsx";
import "./nodes/RenderNode.tsx";
import "./nodes/ImageNode.tsx";
import "./nodes/RoutineNode.tsx";
import { loadProjectSkillsFromData, saveUserSkill, deleteUserSkill as removeUserSkill, exportUserSkills, importUserSkills } from "./skills/user-skills.ts";
import { useState, useEffect, useReducer, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { Canvas } from "./Canvas.tsx";
import { useSocket } from "./use-socket.ts";
import type { ServerMessage } from "./use-socket.ts";
import { HarnessListProvider } from "./use-harness-list.tsx";
import { useAutosave } from "./use-autosave.ts";
import { ProjectList } from "./ProjectList.tsx";
import { ProjectHeader, type ActiveView } from "./ProjectHeader.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import { getProject, updateProject, updateProjectSettings } from "./api.ts";
import type { ProjectSettings } from "./api.ts";
import { canvasReducer, generateId } from "./canvas-state.ts";
import { viewportCenter, findNonOverlappingPosition } from "./canvas-utils.ts";
import { createImageNodeFromProjectPath } from "./nodes/image-node-factory.ts";
import { isImagePath } from "./nodes/image-loader-from-path.ts";
import { graphReducer, createEdge } from "./graph-runtime.ts";
import type { GraphDocument } from "./graph.ts";
import type { CanvasTransform, CanvasNode } from "./types.ts";
import { DEFAULT_THINKING_CONFIG } from "./types.ts";
import { CONTEXT_EXPLORER_PROMPT } from "./prompts/context-explorer.ts";
import { getAllNodeTypes } from "./node-registry.ts";
import type { LeaderData } from "./nodes/LeaderNode.tsx";
import { useKanban } from "./use-kanban.ts";
import { KanbanBoard } from "./KanbanBoard.tsx";
import type { KanbanCard } from "./kanban-types.ts";
import { McpServersBrowser } from "./McpServersBrowser.tsx";
import { SkillsBrowser } from "./SkillsBrowser.tsx";
import { SkillEditor } from "./SkillEditor.tsx";
import { RoutineEditor } from "./RoutineEditor.tsx";
import { DockProvider, DockBar } from "./BottomRightDock.tsx";
import { DebugModeAffordance } from "./components/DebugModeAffordance.tsx";
import { LeaderLoadingScreen } from "./LeaderLoadingScreen.tsx";
import { featureFlagStore } from "./feature-flags.ts";
import type { SkillTemplate } from "./skills/types.ts";
import { getSkill } from "./skills/registry.ts";
import { themes, themeMap, applyTheme, DEFAULT_THEME_ID } from "./themes.ts";
import { ThemeContext, loadPersistedThemeId, persistThemeId } from "./use-theme.ts";
import { usePreventBrowserZoom } from "./use-prevent-browser-zoom.ts";

const WS_URL = `ws://localhost:${import.meta.env["VITE_SERVER_PORT"] ?? "3141"}`;
const PROJECT_HEADER_HEIGHT = 44;

/**
 * Sanitize nodes loaded from persistence — reset transient session state
 * so nodes don't appear active when sessions are gone after a restart.
 */
function sanitizePersistedNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    if (node.type === "leader") {
      const data = node.data as Record<string, unknown>;
      return {
        ...node,
        data: {
          ...data,
          // Reset transient session state
          status: "disconnected",
          streamingText: "",
          streamingBlockIndex: null,
          error: null,
          // Keep sessionKey so sync_session can attempt reconnection
          // Keep messages, totalCost, turns as historical data
        },
      };
    }
    if (node.type === "minion") {
      const data = node.data as Record<string, unknown>;
      return {
        ...node,
        data: {
          ...data,
          status: "disconnected",
          streamingText: "",
          streamingBlockIndex: null,
          error: null,
        },
      };
    }
    if (node.type === "claude-session") {
      const data = node.data as Record<string, unknown>;
      return {
        ...node,
        data: {
          ...data,
          status: "disconnected",
          streamingText: "",
          streamingBlockIndex: null,
          error: null,
        },
      };
    }
    return node;
  });
}

function buildLeaderPrompt(card: KanbanCard): string {
  let prompt = `# Task: ${card.title}\n\n`;
  if (card.description) prompt += `${card.description}\n\n`;
  if (card.context) prompt += `## Context\n${card.context}\n\n`;
  if (card.subtasks.length > 0) {
    prompt += `## Subtasks\n`;
    for (const st of card.subtasks) {
      prompt += `- [${st.done ? "x" : " "}] ${st.title}\n`;
    }
  }
  return prompt.trim();
}

function ProjectView({
  projectId,
  projectPath,
  onClose,
}: {
  projectId: string;
  projectPath: string;
  onClose: () => void;
}) {
  const socket = useSocket(WS_URL);
  const [nodes, dispatch] = useReducer(canvasReducer, []);
  const [graph, graphDispatch] = useReducer(graphReducer, { edges: [] } as GraphDocument);
  const [transform, setTransform] = useState<CanvasTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const [projectName, setProjectName] = useState("Loading...");
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>({});
  const [loaded, setLoaded] = useState(false);
  // Loader-overlay state machine: the LeaderLoadingScreen plays its
  // one-shot animation + 1s hold, then signals `loaderAnimDone`.
  // Once both `loaded` and `loaderAnimDone` are true we fade the
  // overlay out, and on transitionend we unmount it.
  const [loaderAnimDone, setLoaderAnimDone] = useState(false);
  const [loaderUnmounted, setLoaderUnmounted] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("kanban");

  // Skills customization state
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillTemplate | null>(null);
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0);

  // Routine editor state. Gated by the `routines` feature flag — when
  // the flag is off the editor and its dock pill are not rendered at all.
  const [routineEditorOpen, setRoutineEditorOpen] = useState(false);
  const routinesFlagStore = useMemo(() => featureFlagStore("routines"), []);
  const routinesEnabled = useSyncExternalStore(
    routinesFlagStore.subscribe,
    routinesFlagStore.getSnapshot,
    routinesFlagStore.getSnapshot,
  );

  // Load project from API
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const project = await getProject(projectId);
        if (cancelled) return;
        setProjectName(project.name);
        setTransform(project.transform);
        setProjectSettings(project.settings ?? {});
        loadProjectSkillsFromData(projectId, project.skills ?? []);
        setSkillsRefreshKey((k) => k + 1);
        dispatch({ type: "SET_NODES", nodes: sanitizePersistedNodes(project.nodes) });
        graphDispatch({ type: "SET_EDGES", edges: project.graph?.edges ?? [] });
        setLoaded(true);
      } catch (err) {
        console.error("Failed to load project:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Auto-save
  const { status: saveStatus, lastSaved, retryCount, retry } = useAutosave(
    loaded ? projectId : null,
    nodes,
    graph,
    transform,
  );

  const handleRename = useCallback(
    (name: string) => {
      setProjectName(name);
      void updateProject(projectId, { name });
    },
    [projectId],
  );

  const handleSettingsChange = useCallback(
    (newSettings: ProjectSettings) => {
      setProjectSettings(newSettings);
      void updateProjectSettings(projectId, newSettings);
    },
    [projectId],
  );

  /** Compute a non-overlapping position centered in the current viewport. */
  const positionInViewport = useCallback(
    (w: number, h: number) => {
      const center = viewportCenter(transform);
      return findNonOverlappingPosition(
        center.x - w / 2,
        center.y - h / 2,
        w,
        h,
        nodes,
      );
    },
    [transform, nodes],
  );

  // Spawn a Leader node to explore the project and generate context.md
  const handleSpawnContextExplorer = useCallback(() => {
    const typeDef = getAllNodeTypes().find((t) => t.type === "leader");
    if (!typeDef) return;

    const node: CanvasNode = {
      id: generateId(),
      type: "leader",
      position: positionInViewport(typeDef.defaultSize.width, typeDef.defaultSize.height),
      size: { ...typeDef.defaultSize },
      data: {
        sessionKey: null,
        status: "disconnected",
        messages: [],
        streamingText: "",
        totalCost: 0,
        turns: 0,
        error: null,
        model: projectSettings.defaultLeaderModel ?? projectSettings.defaultModel ?? "claude-opus-4-7",
        permissionMode: projectSettings.defaultPermissionMode ?? "auto",
        harness: projectSettings.defaultLeaderHarness ?? "claude",
        thinkingConfig: {
          ...(projectSettings.defaultLeaderThinkingConfig ?? DEFAULT_THINKING_CONFIG),
        },
        // Special flag: auto-start with context explorer prompt
        autoStartPrompt: CONTEXT_EXPLORER_PROMPT(projectPath),
        skillIds: [],
        skillValues: {},
        skillPanelOpen: false,
      },
    };
    dispatch({ type: "ADD_NODE", node });
  }, [projectPath, positionInViewport, projectSettings]);

  // Open a file from the project tree. Images spawn an ImageNode so the
  // user gets a real preview (and annotation surface); everything else
  // opens in a FileViewer. If the image fetch/decode fails we fall back
  // to FileViewer rather than leaving the user with no affordance.
  const handleOpenFile = useCallback(
    async (relativePath: string) => {
      if (isImagePath(relativePath) && projectPath) {
        const noop = (): void => {};
        const ok = await createImageNodeFromProjectPath(
          projectPath,
          relativePath,
          dispatch,
          noop,
          transform,
          nodes,
        );
        if (ok) return;
      }

      const typeDef = getAllNodeTypes().find((t) => t.type === "file-viewer");
      if (!typeDef) return;

      const node: CanvasNode = {
        id: generateId(),
        type: "file-viewer",
        position: positionInViewport(typeDef.defaultSize.width, typeDef.defaultSize.height),
        size: { ...typeDef.defaultSize },
        data: { filePath: relativePath },
      };
      dispatch({ type: "ADD_NODE", node });
    },
    [positionInViewport, projectPath, transform, nodes],
  );

  // Focus-node state for Kanban → Canvas navigation
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const x = window.innerWidth / 2 - node.position.x - node.size.width / 2;
      const y = window.innerHeight / 2 - node.position.y - node.size.height / 2;
      setTransform({ x, y, scale: 1 });
      setFocusNodeId(nodeId);
      setActiveView("canvas");
    },
    [nodes, setTransform],
  );

  const handleFocusNodeHandled = useCallback(() => {
    setFocusNodeId(null);
  }, []);

  // Kanban board state
  const { board: kanbanBoard, dispatch: kanbanDispatch } = useKanban(projectId);

  // Launch a Leader node pre-tagged with a skill from the SkillsBrowser
  const handleLaunchSkill = useCallback((skillId: string) => {
    const typeDef = getAllNodeTypes().find((t) => t.type === "leader");
    if (!typeDef) return;

    const node: CanvasNode = {
      id: generateId(),
      type: "leader",
      position: positionInViewport(typeDef.defaultSize.width, typeDef.defaultSize.height),
      size: { ...typeDef.defaultSize },
      data: {
        sessionKey: null,
        status: "disconnected",
        messages: [],
        streamingText: "",
        totalCost: 0,
        turns: 0,
        error: null,
        model: projectSettings.defaultLeaderModel ?? projectSettings.defaultModel ?? "claude-opus-4-7",
        permissionMode: projectSettings.defaultPermissionMode ?? "auto",
        harness: projectSettings.defaultLeaderHarness ?? "claude",
        thinkingConfig: {
          ...(projectSettings.defaultLeaderThinkingConfig ?? DEFAULT_THINKING_CONFIG),
        },
        taskPlan: [],
        worktreeIsolation: projectSettings.defaultWorktreeIsolation === true,
        worktreePath: null,
        worktreeBranch: null,
        worktreeStatus: "none",
        skillIds: [skillId],
        skillValues: {},
        skillPanelOpen: true,
      },
    };
    dispatch({ type: "ADD_NODE", node });
  }, [dispatch, positionInViewport, projectSettings]);

  // Skills customization handlers
  const handleCreateSkill = useCallback(() => {
    setEditingSkill(null);
    setSkillEditorOpen(true);
  }, []);

  const handleEditSkill = useCallback((skill: SkillTemplate) => {
    setEditingSkill(skill);
    setSkillEditorOpen(true);
  }, []);

  const handleSaveSkill = useCallback((skill: SkillTemplate) => {
    void saveUserSkill(skill);
    setSkillEditorOpen(false);
    setEditingSkill(null);
    setSkillsRefreshKey((k) => k + 1);
  }, []);

  const handleDeleteSkill = useCallback((skillId: string) => {
    if (!confirm(`Delete skill "${getSkill(skillId)?.name ?? skillId}"?`)) return;
    void removeUserSkill(skillId);
    setSkillsRefreshKey((k) => k + 1);
  }, []);

  const handleImportSkills = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        void (async () => {
          try {
            const count = await importUserSkills(reader.result as string);
            setSkillsRefreshKey((k) => k + 1);
            alert(`Imported ${count} skill(s)`);
          } catch (err) {
            alert(`Import failed: ${err instanceof Error ? err.message : "Unknown error"}`);
          }
        })();
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  const handleExportSkills = useCallback(() => {
    const json = exportUserSkills();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "skills.json";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // Launch a Leader node from a Kanban card
  const handleLaunchLeader = useCallback(
    (card: KanbanCard) => {
      const typeDef = getAllNodeTypes().find((t) => t.type === "leader");
      if (!typeDef) return;

      const prompt = buildLeaderPrompt(card);
      const nodeId = generateId();

      const node: CanvasNode = {
        id: nodeId,
        type: "leader",
        position: positionInViewport(typeDef.defaultSize.width, typeDef.defaultSize.height),
        size: { ...typeDef.defaultSize },
        data: {
          sessionKey: null,
          status: "disconnected",
          messages: [],
          streamingText: "",
          totalCost: 0,
          turns: 0,
          error: null,
          model: card.model ?? "sonnet",
          permissionMode: card.permissionMode ?? "auto",
          taskPlan: [],
          autoStartPrompt: prompt,
          worktreeIsolation: card.worktreeIsolation ?? false,
          worktreePath: null,
          worktreeBranch: null,
          worktreeStatus: "none",
          skillIds: card.skillIds ?? [],
          skillValues: card.skillValues ?? {},
          skillPanelOpen: false,
        },
      };
      dispatch({ type: "ADD_NODE", node });

      // Create edges from linked context nodes → leader's context-in port
      for (const contextNodeId of card.linkedContextNodeIds ?? []) {
        const contextNode = nodes.find((n) => n.id === contextNodeId);
        if (!contextNode) continue;
        const edge = createEdge(
          contextNodeId,
          "context-out",
          contextNode.type,
          nodeId,
          "context-in",
          "leader",
          node.data, // pass node data so guard can verify session not started
        );
        if (edge) {
          graphDispatch({ type: "ADD_EDGE", edge });
        }
      }

      // Bind the kanban card to this leader node and move to in-progress
      kanbanDispatch({ type: "BIND_LEADER", cardId: card.id, leaderNodeId: nodeId });
    },
    [kanbanDispatch, nodes, graphDispatch, positionInViewport],
  );

  const handleCreateKanbanCardFromMarkdown = useCallback(
    (source: { nodeId: string; title: string; content: string }) => {
      const card: KanbanCard = {
        id: `kb-${generateId()}`,
        title: source.title.trim(),
        description: source.content.trim(),
        context: "",
        subtasks: [],
        priority: "medium",
        columnId: "backlog",
        createdAt: Date.now(),
        model: "sonnet",
        permissionMode: "auto",
        worktreeIsolation: projectSettings.defaultWorktreeIsolation === true,
        skillIds: [],
        skillValues: {},
        linkedContextNodeIds: [],
      };
      kanbanDispatch({ type: "ADD_CARD", card });
    },
    [kanbanDispatch, projectSettings.defaultWorktreeIsolation],
  );

  // Close a card from "Ready for Review" → "Agent History"
  const handleCloseCard = useCallback(
    (card: KanbanCard) => {
      // Find the leader node to get cost info
      const leaderNode = card.leaderNodeId
        ? nodes.find((n) => n.id === card.leaderNodeId)
        : undefined;
      const leaderData = leaderNode?.data as LeaderData | undefined;
      kanbanDispatch({
        type: "COMPLETE_CARD",
        cardId: card.id,
        summary: leaderData?.messages?.length
          ? `Completed in ${leaderData.turns} turns`
          : undefined,
        cost: leaderData?.totalCost,
        archivedMessages: leaderData?.messages,
        archivedTaskPlan: leaderData?.taskPlan,
        archivedTaskName: leaderData?.taskName,
        archivedTurns: leaderData?.turns,
      });

      // Stop the session and remove the canvas node
      if (leaderData?.sessionKey) {
        socket.send({ type: "stop_session", sessionKey: leaderData.sessionKey });
      }
      if (card.leaderNodeId) {
        dispatch({ type: "REMOVE_NODE", id: card.leaderNodeId });
      }
    },
    [nodes, kanbanDispatch, socket, dispatch],
  );

  const handleResumeCard = useCallback(
    (card: KanbanCard) => {
      if (card.columnId === "halted") {
        kanbanDispatch({ type: "RESUME_HALTED_CARD", cardId: card.id });
      } else {
        kanbanDispatch({ type: "UNBLOCK_CARD", cardId: card.id });
      }
      if (card.leaderNodeId) {
        setFocusNodeId(card.leaderNodeId);
        setActiveView("canvas");
      }
    },
    [kanbanDispatch],
  );

  // Build leaderStatuses map from canvas nodes for the Kanban board
  const leaderStatuses = useMemo(() => {
    const map = new Map<string, { status: string; worktreeStatus: string; cost: number; turns: number }>();
    for (const node of nodes) {
      if (node.type === "leader") {
        const data = node.data as LeaderData;
        map.set(node.id, {
          status: data.status,
          worktreeStatus: data.worktreeStatus ?? "none",
          cost: data.totalCost,
          turns: data.turns,
        });
      }
    }
    return map;
  }, [nodes]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const kanbanCardsRef = useRef(kanbanBoard.cards);
  kanbanCardsRef.current = kanbanBoard.cards;

  // Auto-transition kanban cards based on leader node status changes
  const prevLeaderStatusesRef = useRef<Map<string, { status: string; worktreeStatus: string }>>(new Map());
  useEffect(() => {
    const prev = prevLeaderStatusesRef.current;
    for (const card of kanbanBoard.cards) {
      if (!card.leaderNodeId) continue;
      const current = leaderStatuses.get(card.leaderNodeId);

      // Leader node was removed from canvas — remove the kanban card (1:1 sync)
      if (!current) {
        if (card.columnId !== "history") {
          kanbanDispatch({ type: "REMOVE_CARD", cardId: card.id });
        }
        continue;
      }

      const prevStatus = prev.get(card.leaderNodeId);

      // Auto-block when leader is idle/stopped with active worktree (ready for review)
      if (
        card.columnId === "in-progress" &&
        current.worktreeStatus === "active" &&
        (current.status === "idle" || current.status === "stopped") &&
        prevStatus?.status !== current.status
      ) {
        kanbanDispatch({ type: "HALT_CARD", cardId: card.id, reason: "idle_review", detail: "Agent finished — review changes and approve or resume." });
      }

      // Auto-block when leader is idle/stopped without a worktree (no-isolation workflow)
      if (
        card.columnId === "in-progress" &&
        current.worktreeStatus === "none" &&
        (current.status === "idle" || current.status === "stopped") &&
        prevStatus?.status !== current.status
      ) {
        kanbanDispatch({ type: "HALT_CARD", cardId: card.id, reason: "idle_review", detail: "Agent finished — review results and close or resume." });
      }

      // Auto-block when leader disconnects (session lost after server restart)
      if (
        card.columnId === "in-progress" &&
        current.status === "disconnected" &&
        prevStatus?.status && prevStatus.status !== "disconnected"
      ) {
        kanbanDispatch({ type: "HALT_CARD", cardId: card.id, reason: "session_lost", detail: "Session was lost (server restart or disconnect). Resume to re-launch." });
      }

      // Auto-block when leader hits an error
      if (
        card.columnId === "in-progress" &&
        current.status === "error" &&
        prevStatus?.status !== "error"
      ) {
        kanbanDispatch({ type: "HALT_CARD", cardId: card.id, reason: "error", detail: "Agent encountered an error. View on canvas for details." });
      }

      // Auto-resume when user sends a message (status transitions to "running")
      if (
        card.columnId === "halted" &&
        current.status === "running" &&
        prevStatus?.status !== "running"
      ) {
        kanbanDispatch({ type: "RESUME_HALTED_CARD", cardId: card.id });
      }

      // Auto-move to "history" when worktree is merged/discarded
      if (
        card.columnId !== "history" &&
        (current.worktreeStatus === "merged" || current.worktreeStatus === "discarded") &&
        prevStatus?.worktreeStatus !== current.worktreeStatus
      ) {
        // Archive leader data before completing
        const leaderNode = card.leaderNodeId ? nodes.find((n) => n.id === card.leaderNodeId) : undefined;
        const ld = leaderNode?.data as LeaderData | undefined;
        kanbanDispatch({
          type: "COMPLETE_CARD",
          cardId: card.id,
          summary: `Worktree ${current.worktreeStatus}`,
          cost: current.cost,
          archivedMessages: ld?.messages,
          archivedTaskPlan: ld?.taskPlan,
          archivedTaskName: ld?.taskName,
          archivedTurns: ld?.turns,
        });
      }
    }

    // Update prev ref
    const newPrev = new Map<string, { status: string; worktreeStatus: string }>();
    for (const [id, s] of leaderStatuses) {
      newPrev.set(id, { status: s.status, worktreeStatus: s.worktreeStatus });
    }
    prevLeaderStatusesRef.current = newPrev;
  }, [leaderStatuses, kanbanBoard.cards, kanbanDispatch]);

  // ─── Canvas → Kanban reconciliation ──────────────────────
  // Auto-create kanban cards for any active leader node that doesn't already have one,
  // so that ALL active agents are represented on the Kanban board.
  const reconciledLeadersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const boundLeaderIds = new Set(
      kanbanBoard.cards
        .filter((c) => c.leaderNodeId)
        .map((c) => c.leaderNodeId!),
    );

    for (const node of nodes) {
      if (node.type !== "leader") continue;
      const data = node.data as LeaderData;
      // Skip disconnected leaders (not yet active)
      if (data.status === "disconnected") continue;
      // Skip if this leader already has a kanban card
      if (boundLeaderIds.has(node.id)) continue;
      // Skip if we already reconciled this leader (avoid duplicate creates)
      if (reconciledLeadersRef.current.has(node.id)) continue;

      reconciledLeadersRef.current.add(node.id);

      // Derive a title from taskName, autoStartPrompt, or fallback
      let title = "Canvas Agent";
      if (data.taskName) {
        title = data.taskName;
      } else if (data.autoStartPrompt) {
        // Extract first meaningful line from the prompt
        const firstLine = data.autoStartPrompt
          .split("\n")
          .map((l) => l.replace(/^#+\s*/, "").replace(/^Task:\s*/i, "").trim())
          .find((l) => l.length > 0);
        if (firstLine) {
          title = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
        }
      } else if (data.messages.length > 0) {
        const firstUser = data.messages.find((m) => m.role === "user");
        if (firstUser) {
          const text = typeof firstUser.content === "string"
            ? firstUser.content
            : "";
          if (text) {
            title = text.length > 60 ? text.slice(0, 57) + "..." : text;
          }
        }
      }

      const card: KanbanCard = {
        id: `auto-${node.id}`,
        title,
        description: "",
        subtasks: [],
        context: "",
        priority: "medium",
        columnId: "in-progress",
        createdAt: Date.now(),
        model: data.model ?? "sonnet",
        permissionMode: data.permissionMode ?? "auto",
        worktreeIsolation: data.worktreeIsolation ?? false,
        skillIds: data.skillIds ?? [],
        skillValues: data.skillValues ?? {},
        linkedContextNodeIds: [],
        leaderNodeId: node.id,
        autoSynced: true,
      };
      kanbanDispatch({ type: "ADD_CARD", card });
    }
  }, [nodes, kanbanBoard.cards, kanbanDispatch]);

  // Update auto-synced card titles when the leader's taskName changes
  useEffect(() => {
    for (const card of kanbanBoard.cards) {
      if (!card.autoSynced || !card.leaderNodeId) continue;
      const node = nodes.find((n) => n.id === card.leaderNodeId);
      if (!node) continue;
      const data = node.data as LeaderData;
      if (data.taskName && data.taskName !== card.title) {
        kanbanDispatch({
          type: "UPDATE_CARD",
          cardId: card.id,
          data: { title: data.taskName },
        });
      }
    }
  }, [nodes, kanbanBoard.cards, kanbanDispatch]);

  // Reconcile in-progress kanban cards after page load
  // Two mechanisms:
  // 1. Immediate: halt cards whose leader has no sessionKey (session ended before save)
  //    or whose leader node no longer exists on the canvas.
  // 2. sync_response: when sync_session returns found:false, halt the card.
  // 3. Timeout safety net: after 5s, halt any remaining in-progress cards whose
  //    leader is still "disconnected" (sync_session should have resolved by then).
  const loadReconciledRef = useRef(false);
  useEffect(() => {
    if (!loaded || loadReconciledRef.current) return;
    loadReconciledRef.current = true;

    // Immediate reconciliation: cards whose leader has no sessionKey or no node
    for (const card of kanbanCardsRef.current) {
      if (card.columnId !== "in-progress" || !card.leaderNodeId) continue;
      const node = nodesRef.current.find((n) => n.id === card.leaderNodeId);
      if (!node) {
        // Leader node was removed — halt the card
        kanbanDispatch({
          type: "HALT_CARD",
          cardId: card.id,
          reason: "session_lost",
          detail: "Leader node no longer exists. Create a new agent to resume this work.",
        });
        continue;
      }
      const data = node.data as LeaderData;
      if (!data.sessionKey) {
        // Session already ended before save — halt immediately
        kanbanDispatch({
          type: "HALT_CARD",
          cardId: card.id,
          reason: "session_lost",
          detail: "Session was lost (server restart or disconnect). Resume to re-launch.",
        });
      }
    }

    // Timeout safety net: after 5s, halt any remaining in-progress cards
    // whose leader is still disconnected (sync_session should have resolved)
    const timer = setTimeout(() => {
      for (const card of kanbanCardsRef.current) {
        if (card.columnId !== "in-progress" || !card.leaderNodeId) continue;
        const node = nodesRef.current.find((n) => n.id === card.leaderNodeId);
        if (!node) continue;
        const data = node.data as LeaderData;
        if (data.status === "disconnected") {
          kanbanDispatch({
            type: "HALT_CARD",
            cardId: card.id,
            reason: "session_lost",
            detail: "Session was lost (server restart or disconnect). Resume to re-launch.",
          });
        }
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [loaded, kanbanDispatch]);

  // When sync_response returns found: false, halt the corresponding card
  useEffect(() => {
    if (!loaded) return;
    return socket.subscribe((msg: ServerMessage) => {
      if (msg.type !== "sync_response" || msg.found) return;
      const leaderNode = nodesRef.current.find(
        (n) => n.type === "leader" && (n.data as LeaderData).sessionKey === msg.sessionKey,
      );
      if (!leaderNode) return;
      const card = kanbanCardsRef.current.find(
        (c) => c.columnId === "in-progress" && c.leaderNodeId === leaderNode.id,
      );
      if (!card) return;
      kanbanDispatch({
        type: "HALT_CARD",
        cardId: card.id,
        reason: "session_lost",
        detail: "Session was lost (server restart or disconnect). Resume to re-launch.",
      });
    });
  }, [loaded, socket, kanbanDispatch]);

  // The loader overlay sits on top of the project until both data is
  // ready AND the one-shot animation + hold are done. Then it fades
  // out (350ms) and unmounts. The overlay stays mounted across the
  // loaded transition so its SVG animation does not restart.
  const loaderFadingOut = loaded && loaderAnimDone;
  const handleLoaderComplete = useCallback(() => {
    setLoaderAnimDone(true);
  }, []);

  const kanbanBlockedCount = !loaded
    ? 0
    : activeView === "kanban"
      ? 0
      : kanbanBoard.cards.filter((c) => c.columnId === "halted").length;

  const loaderOverlay = !loaderUnmounted ? (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1000,
        opacity: loaderFadingOut ? 0 : 1,
        transition: "opacity 350ms ease-out",
        pointerEvents: loaderFadingOut ? "none" : "auto",
      }}
      onTransitionEnd={(e) => {
        if (e.propertyName === "opacity" && loaderFadingOut) {
          setLoaderUnmounted(true);
        }
      }}
    >
      <LeaderLoadingScreen
        message="Loading project"
        oneShot
        onComplete={handleLoaderComplete}
      />
    </div>
  ) : null;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {loaderOverlay}
      {loaded ? (
        <HarnessListProvider
          send={socket.send}
          subscribe={socket.subscribe}
          connected={socket.connected}
        >
          <>
            <ProjectHeader
              name={projectName}
              saveStatus={saveStatus}
              lastSaved={lastSaved}
              onRename={handleRename}
              onBack={onClose}
              retryCount={retryCount}
              retry={retry}
              activeView={activeView}
              onViewChange={setActiveView}
              kanbanBlockedCount={kanbanBlockedCount}
              settings={projectSettings}
              onSettingsChange={handleSettingsChange}
            />
            {activeView === "kanban" ? (
              <div style={{ position: "absolute", top: PROJECT_HEADER_HEIGHT, left: 0, right: 0, bottom: 0 }}>
                <KanbanBoard
                  board={kanbanBoard}
                  dispatch={kanbanDispatch}
                  onLaunchLeader={handleLaunchLeader}
                  leaderStatuses={leaderStatuses}
                  onCloseCard={handleCloseCard}
                  onResume={handleResumeCard}
                  onFocusNode={handleFocusNode}
                  socketSend={socket.send}
                  socketSubscribe={socket.subscribe}
                  projectPath={projectPath}
                  nodes={nodes}
                  onUpdateNodeData={(nodeId, data) => dispatch({ type: "UPDATE_NODE_DATA", id: nodeId, data })}
                  projectSettings={projectSettings}
                  onOpenCanvas={() => setActiveView("canvas")}
                />
              </div>
            ) : (
              <DockProvider>
                <div style={{ position: "absolute", top: PROJECT_HEADER_HEIGHT, left: 0, right: 0, bottom: 0 }}>
                  <Canvas
                    nodes={nodes}
                    dispatch={dispatch}
                    graph={graph}
                    graphDispatch={graphDispatch}
                    transform={transform}
                    setTransform={setTransform}
                    socketSend={socket.send}
                    socketSubscribe={socket.subscribe}
                    socketConnected={socket.connected}
                    projectPath={projectPath}
                    projectSettings={projectSettings}
                    onProjectSettingsChange={handleSettingsChange}
                    onCreateKanbanCardFromMarkdown={handleCreateKanbanCardFromMarkdown}
                    focusNodeId={focusNodeId}
                    onFocusNodeHandled={handleFocusNodeHandled}
                    viewportTopOffset={PROJECT_HEADER_HEIGHT}
                  />
                  <ProjectPanel
                    projectId={projectId}
                    projectPath={projectPath}
                    projectName={projectName}
                    onSpawnContextExplorer={handleSpawnContextExplorer}
                    nodes={nodes}
                    onOpenFile={handleOpenFile}
                    onUpdateNodeData={(nodeId, data) => dispatch({ type: "UPDATE_NODE_DATA", id: nodeId, data })}
                    onFocusNode={handleFocusNode}
                  />
                  <SkillsBrowser
                    onLaunchSkill={handleLaunchSkill}
                    onCreateSkill={handleCreateSkill}
                    onEditSkill={handleEditSkill}
                    onDeleteSkill={handleDeleteSkill}
                    onImportSkills={handleImportSkills}
                    onExportSkills={handleExportSkills}
                    refreshKey={skillsRefreshKey}
                  />
                  <McpServersBrowser projectId={projectId} />
                  {skillEditorOpen && (
                    <SkillEditor
                      skill={editingSkill}
                      onSave={handleSaveSkill}
                      onClose={() => {
                        setSkillEditorOpen(false);
                        setEditingSkill(null);
                      }}
                    />
                  )}
                  <DockBar
                    onOpenRoutines={
                      routinesEnabled ? () => setRoutineEditorOpen(true) : undefined
                    }
                  />
                  {routinesEnabled && routineEditorOpen && (
                    <RoutineEditor
                      projectId={projectId}
                      onClose={() => setRoutineEditorOpen(false)}
                    />
                  )}
                </div>
              </DockProvider>
            )}
          </>
        </HarnessListProvider>
      ) : null}
    </div>
  );
}

export default function App() {
  const [currentProject, setCurrentProject] = useState<{ id: string; path: string } | null>(null);
  const [themeId, setThemeIdState] = useState(() => loadPersistedThemeId());
  usePreventBrowserZoom();

  // Apply theme on mount and when changed
  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  const setTheme = useCallback((id: string) => {
    setThemeIdState(id);
    persistThemeId(id);
    applyTheme(id);
  }, []);

  const themeCtx = useMemo(
    () => ({
      themeId,
      theme: themeMap[themeId] ?? themeMap[DEFAULT_THEME_ID]!,
      setTheme,
      themes,
    }),
    [themeId, setTheme],
  );

  if (!currentProject) {
    return (
      <ThemeContext.Provider value={themeCtx}>
        <ProjectList
          onOpenProject={(id, projectPath) => setCurrentProject({ id, path: projectPath })}
        />
        <DebugModeAffordance />
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={themeCtx}>
      <ProjectView
        key={currentProject.id}
        projectId={currentProject.id}
        projectPath={currentProject.path}
        onClose={() => setCurrentProject(null)}
      />
      <DebugModeAffordance />
    </ThemeContext.Provider>
  );
}
