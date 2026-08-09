/**
 * Dialectic-planner agent type — a read-only planning agent used by the two
 * sides of a Dialectic node.
 *
 * It carries no MCP tools of its own. The orchestrator launches it with
 * `permissionMode: "plan"` and a mode-specific system prompt, so it can read
 * and search the repository to ground its reasoning but cannot mutate files.
 *
 * Its only special behaviour vs. the default agent: `onComplete` forwards the
 * run's final assistant text to the {@link resolveTurn} bridge so the waiting
 * orchestrator can capture the turn and advance the dialogue.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import { resolveTurn } from "../dialectic/turn-bridge.ts";

const dialecticPlannerAgent: AgentType = {
  id: "dialectic-planner",

  buildSystemPrompt(_ctx: AgentTypeContext, customPrompt?: string): string {
    if (!customPrompt?.trim()) {
      throw new Error("dialectic-planner requires a customPrompt from the dialectic orchestrator");
    }

    return customPrompt;
  },

  getToolGroups(_ctx: AgentTypeContext): AgentToolResult {
    return { toolGroups: {}, mcpToolNames: [] };
  },

  wantsWorktree: false,
  detectsSubagents: false,

  onComplete(ctx: AgentTypeContext, result: Record<string, unknown>): void {
    const isError = !!result["is_error"];
    const raw = result["result"];
    const text = typeof raw === "string" ? raw : "";
    const rawError = result["error"];
    const error = typeof rawError === "string" && rawError.trim() ? rawError : undefined;
    resolveTurn(ctx.sessionKey, { text, isError, error });
  },
};

registerAgentType(dialecticPlannerAgent);

export { dialecticPlannerAgent };
