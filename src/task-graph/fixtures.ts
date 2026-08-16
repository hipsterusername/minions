import type { AttemptState, LogicalState, TaskGraphSnapshotView, VerificationState } from "./types.ts";

export function createGraphFixture(nodeCount = 10): TaskGraphSnapshotView {
  const stageCount = Math.max(1, Math.ceil(nodeCount / 20));
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const attemptState: AttemptState = index % 11 === 0 ? "running" : index % 7 === 0 ? "failed" : index % 5 === 0 ? "blocked" : "queued";
    const logicalState: LogicalState = index % 13 === 0 && index > 0 ? "succeeded" : index % 17 === 0 && index > 0 ? "failed" : "pending";
    const verification: VerificationState = logicalState === "succeeded" ? (index % 2 ? "pending" : "passed") : "not_required";
    const attempt = { id: `attempt-${index}-2`, number: 2, state: attemptState, executor: `worker-${index % 4}`, sessionId: `session-${index}`, startedAt: "2026-08-14T12:00:00.000Z", costUsd: index / 100, tokens: index * 100 };
    return {
      id: `node-${index}`, title: `Task ${index}`, kind: index % 20 === 19 ? "reducer" as const : "task" as const,
      stageId: `stage-${Math.floor(index / 20)}`, logicalState, readiness: attemptState === "running" ? "claimed" as const : index % 3 === 0 ? "ready" as const : "not_ready" as const,
      currentAttempt: attempt, attemptHistory: [{ ...attempt, id: `attempt-${index}-1`, number: 1, state: "failed" as const }, attempt],
      verification: { state: verification, evidenceIds: verification === "passed" ? [`evidence-${index}`] : [] },
      blocker: attemptState === "blocked" ? { category: "input" as const, explanation: "Waiting for operator input" } : null,
      priority: 100 - (index % 100), queueAgeMs: index * 1000, costUsd: index / 100, tokens: index * 100,
      criticalPath: index < 8, stale: index % 31 === 0 && index > 0, inputIds: index ? [`artifact-${index - 1}`] : [], outputArtifactIds: logicalState === "succeeded" ? [`artifact-${index}`] : [], owner: `owner-${index % 3}`, budgetReservedUsd: 0.5, logs: [`Task ${index} dispatched`, `Task ${index} progress`],
    };
  });
  return {
    graphRunId: "run-graph-1", revision: 42, title: `${nodeCount}-node research graph`, status: "running", updatedAt: "2026-08-14T12:30:00.000Z", nodes,
    edges: Array.from({ length: Math.max(0, nodeCount - 1) }, (_, index) => ({ id: `edge-${index}`, source: `node-${index}`, target: `node-${index + 1}`, type: "depends_on" as const, state: index < 8 ? "critical" as const : "ordinary" as const })),
    groups: Array.from({ length: stageCount }, (_, index) => ({ id: `stage-${index}`, title: `Stage ${index + 1}`, kind: "stage" as const, nodeIds: nodes.slice(index * 20, index * 20 + 20).map((node) => node.id), costUsd: nodes.slice(index * 20, index * 20 + 20).reduce((sum, node) => sum + node.costUsd, 0) })),
    evidence: nodes.filter((node) => node.outputArtifactIds.length).map((node) => ({ id: `lineage-${node.id}`, sourceSnapshot: "source-v1", producerAttemptId: node.currentAttempt!.id, artifactId: node.outputArtifactIds[0]!, ...(node.verification.state === "passed" ? { verifierAttemptId: `verifier-${node.id}` } : {}), consumerNodeIds: [], status: node.verification.state })),
    timeline: nodes.map((node, index) => ({ id: `event-${index}`, at: new Date(Date.parse("2026-08-14T12:00:00.000Z") + index * 1000).toISOString(), type: index % 2 ? "progress" as const : "dispatch" as const, summary: `${node.title} update`, nodeId: node.id, attemptId: node.currentAttempt!.id })),
    capacity: { running: nodes.filter((node) => node.currentAttempt?.state === "running").length, limit: 12 }, budget: { spentUsd: nodes.reduce((sum, node) => sum + node.costUsd, 0), limitUsd: 1_000, tokens: nodes.reduce((sum, node) => sum + node.tokens, 0) },
    criticalPath: { nodeIds: nodes.slice(0, 8).map((node) => node.id), observedMs: 90_000, estimatedRemainingMs: 240_000 },
  };
}
