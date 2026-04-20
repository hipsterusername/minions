/**
 * Default agent type — generic session with no MCP tools, no worktree.
 */

import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, McpServerResult } from "./types.ts";

const defaultAgent: AgentType = {
  id: "default",

  buildSystemPrompt(_ctx: AgentTypeContext, customPrompt?: string): string | undefined {
    return customPrompt;
  },

  createMcpServers(_ctx: AgentTypeContext): McpServerResult {
    return {
      mcpServers: {},
      mcpToolNames: [],
    };
  },

  wantsWorktree: false,
  detectsSubagents: false,
};

registerAgentType(defaultAgent);
