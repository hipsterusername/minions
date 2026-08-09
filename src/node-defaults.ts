/**
 * Factory for creating default node data by type.
 *
 * Keeps every node-creation path on the same defaults.
 */
import type { ProjectSettings } from "./api.ts";
import type { ThinkingConfig } from "./types.ts";
import { DEFAULT_THINKING_CONFIG, MINION_THINKING_CONFIG } from "./types.ts";
import { createImageNodeDefaultData } from "./nodes/ImageNode.tsx";
import { createDialecticDefaultData } from "./nodes/DialecticNode.tsx";

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

    case "dialectic":
      return createDialecticDefaultData();

    default:
      return {};
  }
}

/**
 * Seed freshly-created node data with a user-typed value (from the Ctrl+K
 * command palette). The palette lets you type once and pick an action; the
 * typed text lands in the field that makes sense for the chosen node type.
 * Types with nowhere sensible to put text are returned untouched.
 */
export function applyPromptSeed(
  type: string,
  data: unknown,
  value: string,
): unknown {
  const seed = value.trim();
  if (!seed) return data;
  const base = data as Record<string, unknown>;
  switch (type) {
    case "leader":
      // Auto-start the session with the typed prompt.
      return { ...base, autoStartPrompt: seed };
    case "markdown":
      return { ...base, content: seed, title: deriveTitle(seed) };
    case "note":
      return { ...base, text: seed };
    case "file-viewer":
      return { ...base, filePath: seed };
    case "folder":
      return { ...base, folderPath: seed };
    case "context-group":
      return { ...base, name: seed };
    case "dialectic":
      return { ...base, topic: seed };
    default:
      return data;
  }
}

/** First non-empty line, clipped — a readable card title for markdown. */
function deriveTitle(value: string, max = 60): string {
  const firstLine = value.split("\n").find((line) => line.trim()) ?? "";
  const flat = firstLine.trim();
  if (!flat) return "Untitled";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
