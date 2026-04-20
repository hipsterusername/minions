/**
 * Agent type barrel — imports all agent types (triggering self-registration)
 * and re-exports the registry API.
 */

import "./leader.ts";
import "./minion.ts";
import "./default.ts";

export { getAgentType, getAgentTypeOrDefault, registerAgentType } from "./registry.ts";
export type { AgentType, AgentTypeContext, McpServerResult } from "./types.ts";
