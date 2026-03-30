import "./nodes/NoteNode.tsx";
import "./nodes/ClaudeSessionNode.tsx";
import "./nodes/LeaderNode.tsx";
import "./nodes/MinionNode.tsx";
import "./nodes/MarkdownNode.tsx";
import "./skills/built-in/index.ts";
import { initUserSkills, saveUserSkill, deleteUserSkill as removeUserSkill, exportUserSkills, importUserSkills } from "./skills/user-skills.ts";
import { useState, useEffect, useReducer, useCallback, useMemo, useRef } from "react";
import { Canvas } from "./Canvas.tsx";
import { useSocket } from "./use-socket.ts";
import { useAutosave } from "./use-autosave.ts";
import { ProjectList } from "./ProjectList.tsx";
import { ProjectHeader, type ActiveView } from "./ProjectHeader.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import { getProject, updateProject } from "./api.ts";
import type { ProjectSettings } from "./api.ts";
import { canvasReducer, generateId } from "./canvas-state.ts";
import { graphReducer } from "./graph-runtime.ts";
import type { GraphDocument } from "./graph.ts";
import type { CanvasTransform, CanvasNode } from "./types.ts";
import { CONTEXT_EXPLORER_PROMPT } from "./prompts/context-explorer.ts";
import { getAllNodeTypes } from "./node-registry.ts";
import type { LeaderData } from "./nodes/LeaderNode.tsx";
import { useKanban } from "./use-kanban.ts";
import { KanbanBoard } from "./KanbanBoard.tsx";
import type { KanbanCard } from "./kanban-types.ts";
import { SkillsBrowser } from "./SkillsBrowser.tsx";
import { SkillEditor } from "./SkillEditor.tsx";
import type { SkillTemplate } from "./skills/types.ts";
import { getSkill } from "./skills/registry.ts";

const WS_URL = `ws://localhost:${import.meta.env["VITE_SERVER_PORT"] ?? "3141"}`;

// Register user-defined skills from localStorage
initUserSkills();

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
  const [activeView, setActiveView] = useState<ActiveView>("kanban");

  // Skills customization state
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillTemplate | null>(null);
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0);

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
        dispatch({ type: "SET_NODES", nodes: project.nodes });
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
    transform,
  );

  const handleRename = useCallback(
    (name: string) => {
      setProjectName(name);
      void updateProject(projectId, { name });
    },
    [projectId],
  );

  // Spawn a Leader node to explore the project and generate context.md
  const handleSpawnContextExplorer = useCallback(() => {
    const typeDef = getAllNodeTypes().find((t) => t.type === "leader");
    if (!typeDef) return;

    const node: CanvasNode = {
      id: generateId(),
      type: "leader",
      position: { x: 100, y: 100 },
      size: { ...typeDef.defaultSize },
      data: {
        sessionKey: null,
        status: "disconnected",
        messages: [],
        streamingText: "",
        totalCost: 0,
        turns: 0,
        error: null,
        model: "sonnet",
        permissionMode: "bypassPermissions",
        // Special flag: auto-start with context explorer prompt
        autoStartPrompt: CONTEXT_EXPLORER_PROMPT(projectPath),
        skillIds: [],
        skillValues: {},
        skillPanelOpen: false,
      },
    };
    dispatch({ type: "ADD_NODE", node });
  }, [projectPath]);

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
      position: { x: 200, y: 200 },
      size: { ...typeDef.defaultSize },
      data: {
        sessionKey: null,
        status: "disconnected",
        messages: [],
        streamingText: "",
        totalCost: 0,
        turns: 0,
        error: null,
        model: "sonnet",
        permissionMode: "bypassPermissions",
        completedTasks: [],
        worktreeIsolation: true,
        worktreePath: null,
        worktreeBranch: null,
        worktreeStatus: "none",
        skillIds: [skillId],
        skillValues: {},
        skillPanelOpen: true,
      },
    };
    dispatch({ type: "ADD_NODE", node });
  }, [dispatch]);

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
    saveUserSkill(skill);
    setSkillEditorOpen(false);
    setEditingSkill(null);
    setSkillsRefreshKey((k) => k + 1);
  }, []);

  const handleDeleteSkill = useCallback((skillId: string) => {
    if (!confirm(`Delete skill "${getSkill(skillId)?.name ?? skillId}"?`)) return;
    removeUserSkill(skillId);
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
        try {
          const count = importUserSkills(reader.result as string);
          setSkillsRefreshKey((k) => k + 1);
          alert(`Imported ${count} skill(s)`);
        } catch (err) {
          alert(`Import failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
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
        position: { x: 100, y: 100 },
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
          permissionMode: card.permissionMode ?? "bypassPermissions",
          completedTasks: [],
          autoStartPrompt: prompt,
          worktreeIsolation: card.worktreeIsolation ?? true,
          worktreePath: null,
          worktreeBranch: null,
          worktreeStatus: "none",
          skillIds: card.skillIds ?? [],
          skillValues: card.skillValues ?? {},
          skillPanelOpen: false,
        },
      };
      dispatch({ type: "ADD_NODE", node });
      // Bind the kanban card to this leader node and move to in-progress
      kanbanDispatch({ type: "BIND_LEADER", cardId: card.id, leaderNodeId: nodeId });
    },
    [kanbanDispatch],
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
      });
    },
    [nodes, kanbanDispatch],
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

  // Auto-transition kanban cards based on leader node status changes
  const prevLeaderStatusesRef = useRef<Map<string, { status: string; worktreeStatus: string }>>(new Map());
  useEffect(() => {
    const prev = prevLeaderStatusesRef.current;
    for (const card of kanbanBoard.cards) {
      if (!card.leaderNodeId) continue;
      const current = leaderStatuses.get(card.leaderNodeId);
      if (!current) continue;
      const prevStatus = prev.get(card.leaderNodeId);

      // Auto-move to "review" when worktree becomes active and leader is idle
      if (
        card.columnId === "in-progress" &&
        current.worktreeStatus === "active" &&
        (current.status === "idle" || current.status === "stopped") &&
        prevStatus?.status !== current.status
      ) {
        kanbanDispatch({ type: "MOVE_CARD", cardId: card.id, targetColumnId: "review" });
      }

      // Auto-move to "history" when worktree is merged/discarded
      if (
        card.columnId !== "history" &&
        (current.worktreeStatus === "merged" || current.worktreeStatus === "discarded") &&
        prevStatus?.worktreeStatus !== current.worktreeStatus
      ) {
        kanbanDispatch({
          type: "COMPLETE_CARD",
          cardId: card.id,
          summary: `Worktree ${current.worktreeStatus}`,
          cost: current.cost,
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

  if (!loaded) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-primary)",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 14,
        }}
      >
        Loading project...
      </div>
    );
  }

  const kanbanReviewCount = kanbanBoard.cards.filter((c) => c.columnId === "review").length;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
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
        kanbanReviewCount={kanbanReviewCount}
      />
      {activeView === "kanban" ? (
        <div style={{ position: "absolute", top: 44, left: 0, right: 0, bottom: 0 }}>
          <KanbanBoard
            board={kanbanBoard}
            dispatch={kanbanDispatch}
            onLaunchLeader={handleLaunchLeader}
            leaderStatuses={leaderStatuses}
            onCloseCard={handleCloseCard}
            onFocusNode={handleFocusNode}
            socketSend={socket.send}
            socketSubscribe={socket.subscribe}
            projectPath={projectPath}
          />
        </div>
      ) : (
        <div style={{ position: "absolute", top: 44, left: 0, right: 0, bottom: 0 }}>
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
            focusNodeId={focusNodeId}
            onFocusNodeHandled={handleFocusNodeHandled}
          />
          <ProjectPanel
            projectId={projectId}
            projectPath={projectPath}
            projectName={projectName}
            settings={projectSettings}
            onSpawnContextExplorer={handleSpawnContextExplorer}
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
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [currentProject, setCurrentProject] = useState<{ id: string; path: string } | null>(null);

  if (!currentProject) {
    return (
      <ProjectList
        onOpenProject={(id, projectPath) => setCurrentProject({ id, path: projectPath })}
      />
    );
  }

  return (
    <ProjectView
      key={currentProject.id}
      projectId={currentProject.id}
      projectPath={currentProject.path}
      onClose={() => setCurrentProject(null)}
    />
  );
}
