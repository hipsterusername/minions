import type { NodeTypeDefinition } from "./types.ts";

const registry = new Map<string, NodeTypeDefinition>();

export function registerNodeType(def: NodeTypeDefinition): void {
  registry.set(def.type, def);
}

export function getNodeType(type: string): NodeTypeDefinition | undefined {
  return registry.get(type);
}

export function getAllNodeTypes(): NodeTypeDefinition[] {
  return Array.from(registry.values());
}

export function getUserCreatableNodeTypes(): NodeTypeDefinition[] {
  return Array.from(registry.values()).filter((def) => def.userCreatable !== false);
}
