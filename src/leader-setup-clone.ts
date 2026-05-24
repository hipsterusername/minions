import type { GraphEdge } from "./graph.ts";
import type { LeaderData } from "./nodes/LeaderNode.tsx";
import { DEFAULT_THINKING_CONFIG } from "./types.ts";

export function cloneLeaderSetupData(source: LeaderData): LeaderData {
  const cloned: LeaderData = {
    sessionKey: null,
    status: "disconnected",
    messages: [],
    streamingText: "",
    streamingBlockIndex: null,
    totalCost: 0,
    turns: 0,
    error: null,
    fullError: null,
    model: source.model,
    permissionMode: source.permissionMode,
    thinkingConfig: { ...(source.thinkingConfig ?? DEFAULT_THINKING_CONFIG) },
    taskPlan: [],
    worktreeIsolation: source.worktreeIsolation,
    worktreePath: null,
    worktreeBranch: null,
    worktreeStatus: "none",
    skillIds: [...(source.skillIds ?? [])],
    skillValues: structuredClone(source.skillValues ?? {}),
    skillPanelOpen: source.skillPanelOpen,
    waitUntil: null,
    waitReason: null,
  };
  if (source.harness) {
    cloned.harness = source.harness;
  }
  return cloned;
}

export function cloneLeaderContextEdges(
  edges: readonly GraphEdge[],
  sourceLeaderId: string,
  targetLeaderId: string,
  createId: () => string,
): GraphEdge[] {
  return edges
    .filter(
      (edge) =>
        edge.targetNodeId === sourceLeaderId &&
        edge.targetPortId === "context-in" &&
        edge.protocol === "context",
    )
    .map((edge) => ({
      id: createId(),
      sourceNodeId: edge.sourceNodeId,
      sourcePortId: edge.sourcePortId,
      targetNodeId: targetLeaderId,
      targetPortId: "context-in",
      protocol: "context",
    }));
}
