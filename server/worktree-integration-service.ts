import type { WorktreeLineageSnapshot } from "../shared/worktree-integration.ts";

export class WorktreeIntegrationServiceError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid_state" | "gate_failed" |
    "queue_busy" | "validation_failed" | "internal", message: string,
    readonly latest: WorktreeLineageSnapshot | null = null) { super(message); }
}

export interface WorktreeIntegrationService {
  createLineage(input: { requestId: string; workItemId: string; targetBranch?: string }): Promise<WorktreeLineageSnapshot>;
  joinLineage(input: { requestId: string; workItemId: string; lineageId: string;
    expectedRevision: number; actor: string }): Promise<WorktreeLineageSnapshot>;
  reviewContribution(input: { requestId: string; contributionId: string; expectedRevision: number;
    decision: "approved" | "rejected"; actor: string; summary: string }): Promise<WorktreeLineageSnapshot>;
  enqueueContribution(input: { requestId: string; contributionId: string;
    expectedRevision: number }): Promise<WorktreeLineageSnapshot>;
  retryContribution(input: { requestId: string; contributionId: string;
    expectedRevision: number }): Promise<WorktreeLineageSnapshot>;
  discardContribution(input: { requestId: string; contributionId: string;
    expectedRevision: number; reason?: string }): Promise<WorktreeLineageSnapshot>;
  reviewFinal(input: { requestId: string; lineageId: string; expectedRevision: number;
    decision: "approved" | "rejected"; actor: string; summary: string }): Promise<WorktreeLineageSnapshot>;
  waiveGate(input: { requestId: string; scope: "contribution" | "lineage";
    contributionId?: string; lineageId: string; gateId: string; expectedRevision: number;
    actor: string; reason: string }): Promise<WorktreeLineageSnapshot>;
  resolveConflict(input: { requestId: string; contributionId: string; queueId: string;
    expectedRevision: number; strategy: "manual" | "ours" | "theirs";
    actor: string; reason: string }): Promise<WorktreeLineageSnapshot>;
  promote(input: { requestId: string; lineageId: string;
    expectedRevision: number }): Promise<WorktreeLineageSnapshot>;
  getStatus(input: { lineageId?: string; workItemId?: string; runKey?: string }): Promise<WorktreeLineageSnapshot | null>;
  /** Every lineage the service can see, newest snapshot per row, for the big-picture list. */
  listLineages(): Promise<WorktreeLineageSnapshot[]>;
}
