/**
 * Client-side preview of the server-owned Leader prompt.
 *
 * This module must never be used as the launch payload. The authoritative
 * prompt is assembled by `server/agents/leader.ts` from the same stable shared
 * core plus the tools and skills actually registered for that server session.
 */

import {
  CLAUDE_LEADER_BUILT_IN_TOOLS,
  LEGACY_LEADER_TOOL_NAMES,
  TASK_GRAPH_LEADER_TOOL_NAMES,
  composeLeaderPrompt,
} from "../../shared/leader-prompt.ts";
import type { LeaderOrchestrationMode } from "../../shared/task-graph-planning-contracts.ts";

export const CLAUDE_BUILT_IN_TOOLS = CLAUDE_LEADER_BUILT_IN_TOOLS;

export function buildBaseLeaderPrompt(
  tools: readonly string[],
  orchestrationMode: LeaderOrchestrationMode = "auto",
): string {
  const graph = orchestrationMode !== "direct";
  return composeLeaderPrompt({
    builtInTools: tools,
    registeredToolNames: graph
      ? TASK_GRAPH_LEADER_TOOL_NAMES : LEGACY_LEADER_TOOL_NAMES,
    promptFeatureIds: [graph ? "task_graph_planning" : "legacy_planning"],
  });
}

/** Default client preview. The server does not accept this string as authority. */
export const LEADER_SYSTEM_PROMPT = buildBaseLeaderPrompt(CLAUDE_BUILT_IN_TOOLS);
