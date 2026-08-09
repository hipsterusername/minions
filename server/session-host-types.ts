import type { Bus } from "./bus.ts";
import type { WorktreeInfo } from "./worktree.ts";
import type { PlannedWorktree } from "./worktree-create.ts";
import type { RuntimeSessionInfo, TaskManagerState } from "./task-tools.ts";
import type { SessionRole, ThinkingConfig } from "./session-host-config.ts";
import type { SessionTerminateReason } from "./session-host-terminate.ts";
import type { SandboxPolicy } from "../shared/workspace-contracts.ts";

export interface SessionHostDeps {
  bus: Bus;
  startChildSession: (opts: StartSessionOptions) => void | Promise<{
    sessionKey: string; harness: string; model: string; permissionMode: string;
  }>;
  forEachLeaderTaskState: (
    fn: (leaderKey: string, state: TaskManagerState) => void,
  ) => void;
  /** Lookup live/persisted runtime metadata for a session key. */
  getSessionRuntime?: (sessionKey: string) => RuntimeSessionInfo | null;
  /** Terminate another live session by key. */
  terminateSession?: (sessionKey: string, reason: SessionTerminateReason) => void;
  /** Wake a waiting leader once every delegated child is terminal. */
  wakeWaitingLeaderIfAllChildrenTerminal?: (leaderKey: string) => void;
  workItemLifecycle?: WorkItemRuntimeLifecycle;
  startWorkItemChildRun?: (input: {
    workItemId: string; parentRunKey: string; taskId: string; requestId: string;
    prompt: string; cwd: string; systemPrompt: string; model?: string;
    harness?: string; thinkingConfig?: ThinkingConfig; permissionMode?: string;
    executorClass?: "mechanical" | "standard" | "reasoning";
    skillIds?: string[];
    /** Called after durable allocation and before provider launch. */
    onAllocated?: (sessionKey: string) => void;
  }) => void | Promise<{ sessionKey: string; harness: string; model: string; permissionMode: string }>;
  resumeWorkItemRun?: (input: { workItemId: string; runKey: string; prompt: string; requestId: string }) => void | Promise<void>;
  continueWorkItemChild?: (input: { workItemId: string; runKey: string; prompt: string; requestId: string }) => void | Promise<void>;
  cleanupLiveEditRun?: (runKey: string) => void;
  transitionWorktreeProvisioning?: (runKey: string,
    outcome: "provisioning" | "active" | "failed", error?: string) => void;
}

export interface WorkItemRuntimeIdentity {
  workItemId: string;
  runKey: string;
  runKind: SessionRunKind;
  parentRunKey: string | null;
  taskId: string | null;
}

export interface WorkItemRuntimeLifecycle {
  providerInitialized(input: WorkItemRuntimeIdentity & { providerSessionId: string; providerGeneration: number; at: number }): void;
  /** Idempotent ensure-working signal; provider continuations may repeat it. */
  runStarted(input: WorkItemRuntimeIdentity & { at: number }): void;
  runWaiting(input: WorkItemRuntimeIdentity & { waitKind: "decision" | "file_conflict" | "timer" | "blocked" | "continuation"; at: number }): void;
  runTerminal(input: WorkItemRuntimeIdentity & {
    outcome: "completed" | "error" | "stopped" | "interrupted";
    finalReportId: string | null;
    finalReport: string | null;
    at: number;
  }): void;
}

export interface ImageAttachment {
  kind: "image";
  filename?: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Pure base64 payload — no `data:` prefix. */
  data: string;
}

export type SessionInvocationKind =
  | "new_run"
  | "resume_open_run"
  | "provider_continuation";
export type SessionRunKind = "primary" | "child";

export interface StartSessionOptions {
  sessionKey: string;
  /**
   * Logical-run semantics for this harness invocation. Omitted only by
   * legacy/external callers and treated as `new_run` during migration.
   */
  invocationKind?: SessionInvocationKind | undefined;
  /** Durable work-item identity; optional for compatibility callers. */
  workItemId?: string | undefined;
  /** Immutable run lineage metadata; omitted by legacy callers. */
  runKind?: SessionRunKind | undefined;
  parentRunKey?: string | null | undefined;
  taskId?: string | null | undefined;
  prompt: string;
  /** User-authored text persisted into the transcript before this invocation starts. */
  displayPrompt?: string | undefined;
  cwd: string;
  resumeId?: string | undefined;
  systemPrompt?: string | undefined;
  role?: SessionRole | undefined;
  /** Skill IDs tagged on this session; Leaders pass them to their Minions. */
  skillIds?: string[] | undefined;
  /** Template values for the tagged skills, inherited by delegated Minions. */
  skillValues?: Record<string, Record<string, string>> | undefined;
  worktreeIsolation?: boolean | undefined;
  parentWorktree?: WorktreeInfo | undefined;
  /** Durable contribution identity allocated before provider launch. */
  plannedContribution?: (PlannedWorktree & { resolutionTargetRef?: string;
    resolutionKind?: "contribution" | "lineage" }) | undefined;
  initialModel?: string | null | undefined;
  thinkingConfig?: ThinkingConfig | null | undefined;
  /** Multimodal attachments riding on the first user message. */
  attachments?: ImageAttachment[] | undefined;
  /** External MCP servers merged alongside the agent's built-in servers. */
  externalMcpServers?: Record<string, unknown> | undefined;
  /** Formatted `mcp__<serverId>__<toolName>` names allowed without prompts. */
  externalMcpToolNames?: string[] | undefined;
  /** Registered AgentHarness name. Defaults to "claude". */
  harness?: string | undefined;
  /** Initial permission mode; only honoured on the first start. */
  permissionMode?: string | undefined;
  /** Explicit provider-neutral execution boundary; resolved against harness support at launch. */
  sandboxPolicy?: SandboxPolicy | undefined;
  executorClass?: "mechanical" | "standard" | "reasoning" | undefined;
  /** Guard for one automatic context-window recovery attempt. */
  contextRecoveryAttempt?: number | undefined;
  contextCheckpointId?: string | undefined;
}
