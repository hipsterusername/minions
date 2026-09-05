import type { ThinkingConfig } from "./session-host-config.ts";

export interface WorkItemInvocation {
  requestId?: string; workItemId: string; runKey: string; prompt: string; resumeId?: string;
  displayPrompt?: string;
  userDirectives?: string[];
  planningContext?: string;
  freshThreadPrompt?: string;
  continuitySource?: "system";
  invocationKind: "new_run" | "resume_open_run";
  parentRunKey?: string; taskId?: string;
  systemPrompt?: string; model?: string; thinkingConfig?: ThinkingConfig;
  attachments?: import("./session-host-types.ts").ImageAttachment[];
  harness?: string; permissionMode?: string;
  sandboxPolicy?: import("../shared/workspace-contracts.ts").SandboxPolicy;
  executorClass?: "mechanical" | "standard" | "reasoning"; skillIds?: string[]; skillSnapshotId?: string | undefined; skillValues?: Record<string, Record<string, string>>;
  toolAllowlist?: string[];
  plannedContribution?: import("./worktree-create.ts").PlannedWorktree & { resolutionTargetRef?: string; resolutionKind?: "contribution" | "lineage" };
}
