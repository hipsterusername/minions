export type GitIntegrationKind = "integrate_contribution" | "promote_lineage";

export interface GitIntegrationOperation {
  id: string; kind: GitIntegrationKind; repositoryPath: string;
  targetRef: string; sourceRef: string; worktreePath?: string | null;
  targetWorktreePath?: string | null;
  contributionId?: string | null; lineageId?: string | null; workItemId?: string | null;
  projectId?: string | null;
  expectedSourceSha: string; expectedTargetSha: string; maxTargetRetries?: number;
  fenceToken: string | number;
}
export interface GitGateContext { operation: GitIntegrationOperation;
  targetSha: string; sourceSha: string; attempt: number }
export interface GitGateVerdict { allowed: boolean; reason?: string }
export type GitIntegrationResult = {
  status: "succeeded"; targetSha: string; resultSha: string; sourceSha: string;
  headReachable: true; cleaned: boolean; recovered: boolean; targetMoved: boolean;
} | {
  status: "conflicted"; targetSha: string; sourceSha: string; conflicts: string[];
  preservedPaths: string[]; error: string;
} | { status: "waiting" | "failed"; targetSha?: string; sourceSha?: string; error: string };
export interface GitIntegrationExecutorOptions {
  requireReviewedTargetInSource?: boolean;
  evaluateGate?: (context: GitGateContext) => Promise<GitGateVerdict>;
  onGateEvaluated?: (context: GitGateContext, verdict: GitGateVerdict) => Promise<void>;
  beforePromote?: (context: GitGateContext & { resultSha: string }) => Promise<void>;
  beforeUpdateRef?: (context: GitGateContext & { resultSha: string }) => Promise<void>;
  afterPromote?: (context: GitGateContext & { resultSha: string }) => Promise<void>;
}
export interface GitConflictDetails { conflicts: string[]; preservedPaths: string[];
  targetSha: string; sourceSha: string }
export interface GitIntegrationStore {
  claimNext(repositoryPath: string, targetRef: string,
    workerId: string): Promise<GitIntegrationOperation | null>;
  finish(entryId: string, status: "succeeded" | "conflicted" | "failed",
    detail: { resultSha?: string; error?: string; conflictDetails?: GitConflictDetails },
    claim: { workerId: string; fenceToken: string | number }): Promise<void>;
  requeue(entryId: string, reason: string,
    claim: { workerId: string; fenceToken: string | number }): Promise<void>;
  markCleaned?(contributionId: string, detail: { headReachable: true; queueId: string;
    resultSha: string }, claim: { workerId: string; fenceToken: string | number }): Promise<void>;
}
