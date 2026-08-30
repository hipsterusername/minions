import "./nodes/ClaudeSessionNode.tsx";
import "./nodes/LeaderNode.tsx";
import "./nodes/MinionNode.tsx";
import "./nodes/MarkdownNode.tsx";
import "./nodes/FileViewerNode.tsx";
import "./nodes/FolderNode.tsx";
import "./nodes/ContextGroupNode.tsx";
import "./nodes/RenderNode.tsx";
import "./nodes/ImageNode.tsx";
import "./nodes/DialecticNode.tsx";
import { loadProjectSkillsFromData, saveUserSkill, deleteUserSkill as removeUserSkill, exportUserSkills, importSkillList } from "./skills/user-skills.ts";
import { parseSkillTransfer } from "./skills/skill-transfer.ts";
import { Suspense, lazy, useState, useEffect, useReducer, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { featureFlagStore, FLAG_MCP_SERVERS } from "./feature-flags.ts";
import { Canvas } from "./Canvas.tsx";
import { useSocket } from "./use-socket.ts";
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
import { graphReducer } from "./graph-runtime.ts";
import type { GraphDocument } from "./graph.ts";
import type { CanvasTransform, CanvasNode } from "./types.ts";
import { DEFAULT_THINKING_CONFIG } from "./types.ts";
import { CONTEXT_EXPLORER_PROMPT } from "./prompts/context-explorer.ts";
import { getAllNodeTypes } from "./node-registry.ts";
import { createDefaultNodeData } from "./node-defaults.ts";
import { ActivityView } from "./ActivityView.tsx";
import { countReviewableLeaders } from "./ChangesView.tsx";
import { useSessionActivity } from "./use-session-activity.ts";
import { mergeCanonicalActivity, useWorkItems } from "./use-work-items.ts";
import { reconcileLegacyCanvasLeaders } from "./canvas-work-item-reconcile.ts";
import { detachSessionCanvasNodes } from "./activity-canvas-detach.ts";
import { sessionBelongsToProject, needsAttention } from "./mobile/mobile-selectors.ts";
import { requestLeaderFullscreen } from "./leader-fullscreen-request.ts";
import { McpServersBrowser } from "./McpServersBrowser.tsx";
import { SkillsBrowser } from "./SkillsBrowser.tsx";
import { DockProvider, DockBar } from "./BottomRightDock.tsx";
import { DebugModeAffordance } from "./components/DebugModeAffordance.tsx";
import { LeaderLoadingScreen } from "./LeaderLoadingScreen.tsx";
import type { SkillTemplate } from "./skills/types.ts";
import { getSkill, getAllSkills } from "./skills/registry.ts";
import { themes, themeMap, applyTheme, DEFAULT_THEME_ID } from "./themes.ts";
import { ThemeContext, loadPersistedThemeId, persistThemeId } from "./use-theme.ts";
import { usePreventBrowserZoom } from "./use-prevent-browser-zoom.ts";
import { buildWsUrl } from "./ws-url.ts";
import { browserLogger } from "./logging.ts";
import { DEFAULT_SANDBOX_POLICY } from "../shared/workspace-contracts.ts";
import type { SettingsSaveState } from "./ContextActionsSettings.tsx";

const WS_URL = buildWsUrl();
const log = browserLogger.child("app");
const PROJECT_HEADER_HEIGHT = 44;
const DEFAULT_DOCUMENT_TITLE = "Minions";

const SkillEditor = lazy(() =>
  import("./SkillEditor.tsx").then(({ SkillEditor: Component }) => ({ default: Component })),
);
const SkillImportModal = lazy(() =>
  import("./SkillImportModal.tsx").then(({ SkillImportModal: Component }) => ({ default: Component })),
);

function ModalLoadingFallback({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--overlay-bg)",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
      }}
    >
      {label}
    </div>
  );
}

export function formatProjectDocumentTitle(projectName: string): string {
  const name = projectName.trim();
  return name ? `${name} (Minions)` : DEFAULT_DOCUMENT_TITLE;
}

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
  const [projectName, setProjectName] = useState("");
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>({});
  const [settingsSaveState, setSettingsSaveState] = useState<SettingsSaveState>({ status: "idle" });
  const settingsSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const settingsSaveRevisionRef = useRef(0);
  const failedSettingsRef = useRef<ProjectSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Loader-overlay state machine: the LeaderLoadingScreen plays its
  // one-shot animation + 1s hold, then signals `loaderAnimDone`.
  // Once both `loaded` and `loaderAnimDone` are true we fade the
  // overlay out, and on transitionend we unmount it.
  const [loaderAnimDone, setLoaderAnimDone] = useState(false);
  const [loaderUnmounted, setLoaderUnmounted] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("activity");

  // MCP servers is a still-evolving feature, gated off by default behind
  // a debug feature flag. When off, the dock panel is not mounted at all.
  const mcpFlagStore = useMemo(() => featureFlagStore(FLAG_MCP_SERVERS), []);
  const mcpServersEnabled = useSyncExternalStore(
    mcpFlagStore.subscribe,
    mcpFlagStore.getSnapshot,
    mcpFlagStore.getSnapshot,
  );

  // Skills customization state
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillTemplate | null>(null);
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0);
  const [skillImport, setSkillImport] = useState<{
    incoming: SkillTemplate[];
    existingIds: Set<string>;
    skipped: number;
  } | null>(null);

  useEffect(() => {
    document.title = formatProjectDocumentTitle(projectName);
    return () => {
      document.title = DEFAULT_DOCUMENT_TITLE;
    };
  }, [projectName]);

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
        log.error("project_load_failed", { error: err });
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
      const revision = ++settingsSaveRevisionRef.current;
      setSettingsSaveState({ status: "saving" });
      const request = settingsSaveQueueRef.current
        .catch(() => undefined)
        .then(() => updateProjectSettings(projectId, newSettings));
      settingsSaveQueueRef.current = request;
      void request.then(() => {
        if (settingsSaveRevisionRef.current !== revision) return;
        failedSettingsRef.current = null;
        setSettingsSaveState({ status: "saved" });
      }).catch((error: unknown) => {
        if (settingsSaveRevisionRef.current !== revision) return;
        failedSettingsRef.current = newSettings;
        setSettingsSaveState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [projectId],
  );

  const retrySettingsSave = useCallback(() => {
    handleSettingsChange(failedSettingsRef.current ?? projectSettings);
  }, [handleSettingsChange, projectSettings]);

  /** Compute a non-overlapping position centered in the current viewport. */
  const positionInViewport = useCallback(
    (w: number, h: number) => {
      const center = viewportCenter(transform, {
        width: window.innerWidth,
        height: Math.max(0, window.innerHeight - PROJECT_HEADER_HEIGHT),
      });
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

  // Spawn a Leader node to explore the project and populate Minions context.
  const handleSpawnContextExplorer = useCallback(() => {
    const typeDef = getAllNodeTypes().find((t) => t.type === "leader");
    if (!typeDef) return undefined;

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
        model: projectSettings.defaultLeaderModel ?? projectSettings.defaultModel ?? "claude-opus-4-8",
        permissionMode: projectSettings.defaultPermissionMode ?? "auto",
        sandboxPolicy: projectSettings.defaultSandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
        harness: projectSettings.defaultLeaderHarness ?? "claude",
        thinkingConfig: {
          ...(projectSettings.defaultLeaderThinkingConfig ?? DEFAULT_THINKING_CONFIG),
        },
        // Special flag: auto-start with context explorer prompt
        autoStartPrompt: CONTEXT_EXPLORER_PROMPT(projectPath),
        skillIds: [],
        skillValues: {},
        skillPanelOpen: false,
        orchestrationMode: projectSettings.leaderPlanningBackend === "legacy"
          ? "direct" : "auto",
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
          viewportCenter(transform, {
            width: window.innerWidth,
            height: Math.max(0, window.innerHeight - PROJECT_HEADER_HEIGHT),
          }),
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

  // Focus-node state for cross-surface Canvas navigation
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

  // Attach an existing backend session (e.g. one launched from the mobile
  // view) to the canvas by creating a leader node bound to its sessionKey,
  // then revealing it. Sessions live in the server registry independent of
  // canvas nodes; this is what lets a phone-started leader show up on the
  // desktop canvas. If the session already has a node we just focus it.
  const handleAttachSessionToCanvas = useCallback(
    (sessionKey: string) => {
      const existing = nodes.find(
        (n) =>
          (n.type === "leader" ||
            n.type === "minion" ||
            n.type === "claude-session") &&
          (n.data as { sessionKey?: string | null }).sessionKey === sessionKey,
      );
      if (existing) {
        handleFocusNode(existing.id);
        return;
      }

      const typeDef = getAllNodeTypes().find((t) => t.type === "leader");
      if (!typeDef) return;

      const { width, height } = typeDef.defaultSize;
      const position = positionInViewport(width, height);
      const nodeId = generateId();
      const node: CanvasNode = {
        id: nodeId,
        type: "leader",
        position,
        size: { ...typeDef.defaultSize },
        data: {
          ...(createDefaultNodeData("leader", projectSettings) as Record<string, unknown>),
          sessionKey,
          status: "idle",
        },
      };
      dispatch({ type: "ADD_NODE", node });

      // The node isn't in `nodes` yet (state update is async), so center the
      // viewport on its known position directly rather than via handleFocusNode.
      const x = window.innerWidth / 2 - position.x - width / 2;
      const y = window.innerHeight / 2 - position.y - height / 2;
      setTransform({ x, y, scale: 1 });
      setFocusNodeId(nodeId);
      setActiveView("canvas");
    },
    [nodes, handleFocusNode, positionInViewport, projectSettings, setTransform],
  );

  const handleLaunchActivityLeader = useCallback(() => {
    const typeDef = getAllNodeTypes().find((t) => t.type === "leader");
    if (!typeDef) return;

    const { width, height } = typeDef.defaultSize;
    const position = positionInViewport(width, height);
    const nodeId = generateId();
    const node: CanvasNode = {
      id: nodeId,
      type: "leader",
      position,
      size: { ...typeDef.defaultSize },
      data: createDefaultNodeData("leader", projectSettings),
    };
    return node;
  }, [positionInViewport, projectSettings]);

  // Session activity (Activity view) — the same live stream the mobile Activity
  // screen consumes, scoped to this project by working directory.
  const { mobileSessions } = useSessionActivity(socket.subscribe);
  const workItemState = useWorkItems({ projectId, connected: socket.connected,
    subscribe: socket.subscribe, send: socket.send });
  const handleDetachSessionFromCanvas = useCallback(
    (session: { sessionKey: string; workItemId?: string | null }) => {
      detachSessionCanvasNodes(nodes, session, {
        send: socket.send,
        dispatch,
        graphDispatch,
        workItem: session.workItemId
          ? workItemState.items[session.workItemId] ?? null
          : null,
      });
    },
    [nodes, socket.send, workItemState.items],
  );
  useEffect(() => {
    for (const patch of reconcileLegacyCanvasLeaders(
      nodes, workItemState.orderedItems, mobileSessions,
    )) dispatch({ type: "UPDATE_NODE_DATA", id: patch.nodeId, data: patch.data });
  }, [nodes, workItemState.orderedItems, mobileSessions, dispatch]);
  const canonicalActivitySessions = useMemo(
    () => mergeCanonicalActivity(mobileSessions, workItemState.orderedItems,
      workItemState.coordination),
    [mobileSessions, workItemState.orderedItems, workItemState.coordination],
  );
  const activitySessions = useMemo(
    () => canonicalActivitySessions.filter((s) => sessionBelongsToProject(s, projectPath, projectId)),
    [canonicalActivitySessions, projectPath, projectId],
  );
  useEffect(() => {
    if (activeView !== "activity" || !socket.connected) return;
    socket.send({ type: "list_sessions" });
  }, [activeView, socket.connected, socket.send]);
  const activityAttentionCount = useMemo(
    () =>
      activitySessions.filter((s) => s.role !== "minion" && needsAttention(s)).length,
    [activitySessions],
  );
  const changesCount = useMemo(
    () => countReviewableLeaders(nodes),
    [nodes],
  );

  // Reveal a leader on the canvas and open its existing fullscreen cockpit.
  // `handleFocusNode` switches to the canvas and centers the node; the
  // fullscreen request is picked up by that LeaderNode as it mounts.
  const handleExpandFullscreen = useCallback(
    (nodeId: string) => {
      handleFocusNode(nodeId);
      requestLeaderFullscreen(nodeId);
    },
    [handleFocusNode],
  );

  const handleStopSession = useCallback(
    (sessionKey: string) => {
      socket.send({ type: "stop_session", sessionKey });
    },
    [socket],
  );

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
        model: projectSettings.defaultLeaderModel ?? projectSettings.defaultModel ?? "claude-opus-4-8",
        permissionMode: projectSettings.defaultPermissionMode ?? "auto",
        sandboxPolicy: projectSettings.defaultSandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
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
        orchestrationMode: projectSettings.leaderPlanningBackend === "legacy"
          ? "direct" : "auto",
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

  // Parse a skills file's text and open the import-preview modal. Shared by the
  // header import button and drag-and-drop onto the panel.
  const openImportPreview = useCallback((text: string) => {
    try {
      const { skills, skipped } = parseSkillTransfer(text);
      if (skills.length === 0) {
        alert(
          skipped > 0
            ? `No valid skills found (${skipped} entr${skipped === 1 ? "y" : "ies"} skipped).`
            : "No skills found in that file.",
        );
        return;
      }
      setSkillImport({
        incoming: skills,
        existingIds: new Set(getAllSkills().map((s) => s.id)),
        skipped,
      });
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }, []);

  const handleImportSkills = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => openImportPreview(reader.result as string);
      reader.readAsText(file);
    };
    input.click();
  }, [openImportPreview]);

  const handleConfirmImport = useCallback((selected: SkillTemplate[]) => {
    void importSkillList(selected).then(() => {
      setSkillsRefreshKey((k) => k + 1);
    });
    setSkillImport(null);
  }, []);

  // Trigger a JSON download of the given skills under `filename`.
  const downloadSkills = useCallback((skills: SkillTemplate[], filename: string) => {
    const json = exportUserSkills(skills);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleExportSkills = useCallback(() => {
    downloadSkills(getAllSkills(), "skills.json");
  }, [downloadSkills]);

  const handleExportSkill = useCallback(
    (skill: SkillTemplate) => {
      downloadSkills([skill], `${skill.id}.skill.json`);
    },
    [downloadSkills],
  );

  const handleDuplicateSkill = useCallback((skill: SkillTemplate) => {
    // Open the editor pre-filled with a copy: a fresh id/name, no builtIn flag,
    // so saving creates a new, editable project skill.
    const existing = new Set(getAllSkills().map((s) => s.id));
    let newId = `${skill.id}-copy`;
    let n = 2;
    while (existing.has(newId)) newId = `${skill.id}-copy-${n++}`;
    const { builtIn: _builtIn, ...rest } = skill;
    setEditingSkill({ ...rest, id: newId, name: `${skill.name} Copy` });
    setSkillEditorOpen(true);
  }, []);

  // The loader overlay sits on top of the project until both data is
  // ready AND the one-shot animation + hold are done. Then it fades
  // out (350ms) and unmounts. The overlay stays mounted across the
  // loaded transition so its SVG animation does not restart.
  const loaderFadingOut = loaded && loaderAnimDone;
  const handleLoaderComplete = useCallback(() => {
    setLoaderAnimDone(true);
  }, []);

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
              activityAttentionCount={activityAttentionCount + changesCount}
              settings={projectSettings}
              onSettingsChange={handleSettingsChange}
              settingsSaveState={settingsSaveState}
              onRetrySettingsSave={retrySettingsSave}
              socketSend={socket.send}
              socketSubscribe={socket.subscribe}
            />
            {activeView === "activity" ? (
              <div style={{ position: "absolute", top: PROJECT_HEADER_HEIGHT, left: 0, right: 0, bottom: 0 }}>
                <ActivityView
                  sessions={activitySessions}
                  nodes={nodes}
                  onLaunchLeader={handleLaunchActivityLeader}
                  onCommitLaunchLeader={(node) => dispatch({ type: "ADD_NODE", node })}
                  onCancelLaunchLeader={(nodeId) => dispatch({ type: "REMOVE_NODE", id: nodeId })}
                  onOpenInCanvas={handleFocusNode}
                  onExpandFullscreen={handleExpandFullscreen}
                  onStopSession={handleStopSession}
                  onAttachToCanvas={handleAttachSessionToCanvas}
                  onDetachFromCanvas={handleDetachSessionFromCanvas}
                  socketSend={socket.send}
                  socketSubscribe={socket.subscribe}
                  projectPath={projectPath}
                  projectSettings={projectSettings}
                  onUpdateNodeData={(nodeId, data) => dispatch({ type: "UPDATE_NODE_DATA", id: nodeId, data })}
                  workItemRuns={workItemState.runs}
                  runNextCursor={workItemState.runNextCursor}
                  onLoadRuns={workItemState.loadRuns}
                  onPromptWorkItem={(workItemId, prompt) => {
                    const item = workItemState.items[workItemId];
                    if (!item) return false;
                    if (item.lifecycle.runtimeState === "waiting"
                      && item.waitKind === "decision" && item.currentRunKey) {
                      workItemState.reply(item, prompt);
                    } else {
                      workItemState.start(item, prompt);
                    }
                    return true;
                  }}
                  promptFailures={workItemState.promptFailures}
                  onClearPromptFailure={workItemState.clearPromptFailure}
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
                    projectId={projectId}
                    projectSettings={projectSettings}
                    onProjectSettingsChange={handleSettingsChange}
                    focusNodeId={focusNodeId}
                    onFocusNodeHandled={handleFocusNodeHandled}
                    viewportTopOffset={PROJECT_HEADER_HEIGHT}
                  />
                  <ProjectPanel
                    projectId={projectId}
                    projectPath={projectPath}
                    projectName={projectName}
                    onSpawnContextExplorer={handleSpawnContextExplorer}
                    socketSubscribe={socket.subscribe}
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
                    onDuplicateSkill={handleDuplicateSkill}
                    onExportSkill={handleExportSkill}
                    onImportSkills={handleImportSkills}
                    onExportSkills={handleExportSkills}
                    onImportFile={openImportPreview}
                    refreshKey={skillsRefreshKey}
                  />
                  {mcpServersEnabled && (
                    <McpServersBrowser projectId={projectId} />
                  )}
                  {skillEditorOpen && (
                    <Suspense fallback={<ModalLoadingFallback label="Loading skill editor…" />}>
                      <SkillEditor
                        skill={editingSkill}
                        onSave={handleSaveSkill}
                        onClose={() => {
                          setSkillEditorOpen(false);
                          setEditingSkill(null);
                        }}
                      />
                    </Suspense>
                  )}
                  {skillImport && (
                    <Suspense fallback={<ModalLoadingFallback label="Loading skill import…" />}>
                      <SkillImportModal
                        incoming={skillImport.incoming}
                        existingIds={skillImport.existingIds}
                        skipped={skillImport.skipped}
                        onConfirm={handleConfirmImport}
                        onClose={() => setSkillImport(null)}
                      />
                    </Suspense>
                  )}
                  <DockBar />
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
