import type {
  WorkItemBindingSurface,
  WorkItemDetailSnapshot,
  WorkItemListSnapshot,
  WorkItemRunSnapshot,
  WorkItemServiceErrorCode,
} from "../shared/work-item-contracts.ts";
import type { ChangeMode } from "../shared/work-item-lifecycle.ts";
import type { SandboxPolicy } from "../shared/workspace-contracts.ts";
import type { LeaderOrchestrationMode } from "../shared/task-graph-planning-contracts.ts";

export interface WorkItemMutationContext {
  requestId: string;
}

export interface ExistingWorkItemMutationContext extends WorkItemMutationContext {
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string | null;
}

export class WorkItemServiceError extends Error {
  override readonly name = "WorkItemServiceError";
  constructor(
    readonly code: WorkItemServiceErrorCode,
    message: string,
    readonly latest: WorkItemDetailSnapshot | null = null,
  ) {
    super(message);
  }
}

export interface WorkItemService {
  saveCommandResponse?(requestId: string, response: Record<string, unknown>): void;
  getCommandResponse?(requestId: string): Record<string, unknown> | null;
  create(input: WorkItemMutationContext & {
    projectId: string; projectPath: string; title: string; changeMode: ChangeMode;
  }): Promise<WorkItemDetailSnapshot>;
  continue(input: ExistingWorkItemMutationContext & { workItemId: string; prompt: string;
    displayPrompt?: string;
    harness?: string; model?: string; permissionMode?: string; sandboxPolicy?: SandboxPolicy; thinkingConfig?: unknown; skillIds?: string[];
    skillValues?: Record<string, Record<string, string>>;
    systemPrompt?: string; attachments?: unknown[];
    orchestrationMode?: LeaderOrchestrationMode }): Promise<WorkItemDetailSnapshot>;
  startRun(input: ExistingWorkItemMutationContext & { workItemId: string; prompt: string;
    displayPrompt?: string;
    harness?: string; model?: string; permissionMode?: string; sandboxPolicy?: SandboxPolicy; thinkingConfig?: unknown; skillIds?: string[];
    skillValues?: Record<string, Record<string, string>>;
    systemPrompt?: string; attachments?: unknown[];
    orchestrationMode?: LeaderOrchestrationMode }): Promise<WorkItemDetailSnapshot>;
  replyToWaitingRun(input: ExistingWorkItemMutationContext & { workItemId: string; runKey: string;
    prompt: string; displayPrompt?: string; continuitySource?: "system"; skillIds?: string[];
    skillValues?: Record<string, Record<string, string>> }): Promise<WorkItemDetailSnapshot>;
  review(input: ExistingWorkItemMutationContext & { workItemId: string }): Promise<WorkItemDetailSnapshot>;
  archive(input: ExistingWorkItemMutationContext & { workItemId: string }): Promise<WorkItemDetailSnapshot>;
  restore(input: ExistingWorkItemMutationContext & { workItemId: string }): Promise<WorkItemDetailSnapshot>;
  attach(input: ExistingWorkItemMutationContext & { workItemId: string; surface: WorkItemBindingSurface; bindingId: string }): Promise<WorkItemDetailSnapshot>;
  detach(input: ExistingWorkItemMutationContext & { workItemId: string; surface: WorkItemBindingSurface; bindingId: string }): Promise<WorkItemDetailSnapshot>;
  get(workItemId: string, cursor?: string, limit?: number): Promise<WorkItemDetailSnapshot | null>;
  list(input: { projectId: string; includeArchived?: boolean; cursor?: string; limit?: number }): Promise<WorkItemListSnapshot>;
  getRuns(input: { workItemId: string; cursor?: string; limit?: number }): Promise<{
    workItemId: string; runs: WorkItemRunSnapshot[]; nextCursor: string | null;
  }>;
}
