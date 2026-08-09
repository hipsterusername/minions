/**
 * Agent type registry — central map of role ID → AgentType implementation.
 *
 * Each agent type self-registers via `registerAgentType()` at import time.
 */

import type { AgentType } from "./types.ts";

const registry = new Map<string, AgentType>();

/**
 * Register an agent type. Called at module-load time by each agent file.
 * Throws if a duplicate ID is registered.
 */
export function registerAgentType(agentType: AgentType): void {
  if (registry.has(agentType.id)) {
    throw new Error(`AgentType "${agentType.id}" is already registered`);
  }
  registry.set(agentType.id, agentType);
}

/**
 * Look up an agent type by ID. Throws if not found.
 */
export function getAgentType(id: string): AgentType {
  const agentType = registry.get(id);
  if (!agentType) {
    throw new Error(
      `Unknown agent type "${id}". Registered types: ${Array.from(registry.keys()).join(", ")}`,
    );
  }
  return agentType;
}

/**
 * Look up an agent type by ID, falling back to "default" if not found.
 */
export function getAgentTypeOrDefault(id: string): AgentType {
  return registry.get(id) ?? getAgentType("default");
}
