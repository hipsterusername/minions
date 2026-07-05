/**
 * Factory for creating default node data by type.
 *
 * Centralises the defaultData switch that was previously duplicated
 * in Canvas.tsx's addNode() and addNodeAtPosition().
 */
import type { ProjectSettings } from "./api.ts";
import type { ThinkingConfig } from "./types.ts";
import { DEFAULT_THINKING_CONFIG, MINION_THINKING_CONFIG } from "./types.ts";
import { createImageNodeDefaultData } from "./nodes/ImageNode.tsx";

export function createDefaultNodeData(
  type: string,
  projectSettings?: ProjectSettings,
): unknown {
  switch (type) {
    case "claude-session":
      return {
        sessionKey: null,
        status: "disconnected",
        messages: [],
        streamingText: "",
        streamingBlockIndex: null,
        totalCost: 0,
        turns: 0,
        error: null,
        model: "sonnet",
        permissionMode: projectSettings?.defaultPermissionMode ?? "auto",
        modelUsage: null,
        lastDurationMs: null,
        subagents: [],
        promptSuggestions: [],
        initData: null,
        thinkingConfig: cloneThinkingConfig(DEFAULT_THINKING_CONFIG),
      };

    case "leader":
      return {
        sessionKey: null,
        status: "disconnected",
        messages: [],
        streamingText: "",
        streamingBlockIndex: null,
        totalCost: 0,
        turns: 0,
        error: null,
        model: projectSettings?.defaultLeaderModel ?? "claude-opus-4-8",
        harness: projectSettings?.defaultLeaderHarness ?? "claude",
        permissionMode: projectSettings?.defaultPermissionMode ?? "auto",
        taskPlan: [],
        worktreeIsolation: projectSettings?.defaultWorktreeIsolation === true,
        worktreePath: null,
        worktreeBranch: null,
        worktreeStatus: "none",
        skillIds: [],
        skillValues: {},
        skillPanelOpen: false,
        systemPromptPrefix: null,
        thinkingConfig: resolveLeaderThinkingConfig(projectSettings),
      };

    case "minion":
      return {
        sessionKey: null,
        status: "waiting",
        leaderId: null,
        taskQueue: [],
        activeTaskIndex: -1,
        messages: [],
        streamingText: "",
        streamingBlockIndex: null,
        totalCost: 0,
        turns: 0,
        error: null,
        model: projectSettings?.defaultMinionModel ?? "claude-sonnet-5",
        harness: projectSettings?.defaultMinionHarness ?? "claude",
        permissionMode: projectSettings?.defaultPermissionMode ?? "auto",
        thinkingConfig: cloneThinkingConfig(
          projectSettings?.defaultMinionThinkingConfig ?? MINION_THINKING_CONFIG,
        ),
      };

    case "markdown":
      return { title: "Untitled", content: "", viewMode: "edit" };

    case "file-viewer":
      return { filePath: "" };

    case "folder":
      return { folderPath: "" };

    case "context-group":
      return { name: "" };

    case "image":
      return createImageNodeDefaultData();

    default:
      return {};
  }
}

function cloneThinkingConfig(config: ThinkingConfig): ThinkingConfig {
  return { ...config };
}

function resolveLeaderThinkingConfig(
  projectSettings?: ProjectSettings,
): ThinkingConfig {
  if (projectSettings?.defaultLeaderThinkingConfig) {
    return cloneThinkingConfig(projectSettings.defaultLeaderThinkingConfig);
  }
  return {
    ...DEFAULT_THINKING_CONFIG,
    effort: isFableModel(projectSettings?.defaultLeaderModel)
      ? "medium"
      : DEFAULT_THINKING_CONFIG.effort,
  };
}

function isFableModel(model: unknown): boolean {
  return model === "claude-fable-5" || model === "fable";
}
