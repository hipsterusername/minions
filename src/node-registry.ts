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

/** Returns true if parentType owns/manages childType as a child node. */
export function nodeOwnsType(parentType: string, childType: string): boolean {
  const def = registry.get(parentType);
  return def?.ownsChildrenOfType?.includes(childType) ?? false;
}

/** Returns true if the given node type acts as a spatial container. */
export function isContainerType(type: string): boolean {
  return registry.get(type)?.isContainer ?? false;
}

/** Returns true if the given node type can provide context content. */
export function isContextProvider(type: string): boolean {
  return registry.get(type)?.providesContext ?? false;
}

/** Returns the content extractor function for the given node type, if registered. */
export function getContentExtractor(type: string): ((data: unknown) => string | null) | undefined {
  return registry.get(type)?.extractContent;
}
