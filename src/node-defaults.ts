/**
 * Factory for creating default node data by type.
 *
 * Centralises the defaultData switch that was previously duplicated
 * in Canvas.tsx's addNode() and addNodeAtPosition().
 */
import type { ProjectSettings } from "./api.ts";

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
      };

    case "leader":
      return {
        sessionKey: null,
        status: "disconnected",
        messages: [],
        streamingText: "",
        totalCost: 0,
        turns: 0,
        error: null,
        model: (projectSettings?.defaultLeaderModel as string) ?? "opus",
        permissionMode: projectSettings?.defaultPermissionMode ?? "auto",
        taskPlan: [],
        worktreeIsolation: projectSettings?.defaultWorktreeIsolation === true,
        worktreePath: null,
        worktreeBranch: null,
        worktreeStatus: "none",
        skillIds: [],
        skillValues: {},
        skillPanelOpen: false,
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
        totalCost: 0,
        turns: 0,
        error: null,
        model: (projectSettings?.defaultMinionModel as string) ?? "sonnet",
        permissionMode: projectSettings?.defaultPermissionMode ?? "auto",
      };

    case "markdown":
      return { title: "Untitled", content: "", viewMode: "edit" };

    case "file-viewer":
      return { filePath: "" };

    case "folder":
      return { folderPath: "" };

    case "context-group":
      return { name: "" };

    default:
      return {};
  }
}
