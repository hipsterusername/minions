/**
 * Default agent type — generic session with no MCP tools, no worktree.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";

const defaultAgent: AgentType = {
  id: "default",

  buildSystemPrompt(_ctx: AgentTypeContext, customPrompt?: string): string | undefined {
    return customPrompt;
  },

  getToolGroups(_ctx: AgentTypeContext): AgentToolResult {
    return {
      toolGroups: {},
      mcpToolNames: [],
    };
  },

  wantsWorktree: false,
  detectsSubagents: false,
};

registerAgentType(defaultAgent);
