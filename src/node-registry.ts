import type { ContextAttachment, NodeTypeDefinition } from "./types.ts";
import "./nodes/SystemGraphNode.tsx";

var registry: Map<string, NodeTypeDefinition> | undefined;

function nodeRegistry(): Map<string, NodeTypeDefinition> {
  registry ??= new Map<string, NodeTypeDefinition>();
  return registry;
}

export function registerNodeType(def: NodeTypeDefinition): void {
  nodeRegistry().set(def.type, def);
}

export function getNodeType(type: string): NodeTypeDefinition | undefined {
  return nodeRegistry().get(type);
}

export function getAllNodeTypes(): NodeTypeDefinition[] {
  return Array.from(nodeRegistry().values());
}

export function getUserCreatableNodeTypes(): NodeTypeDefinition[] {
  return Array.from(nodeRegistry().values()).filter((def) => def.userCreatable !== false);
}

/** Returns true if parentType owns/manages childType as a child node. */
export function nodeOwnsType(parentType: string, childType: string): boolean {
  const def = nodeRegistry().get(parentType);
  return def?.ownsChildrenOfType?.includes(childType) ?? false;
}

/** Returns true if the given node type acts as a spatial container. */
export function isContainerType(type: string): boolean {
  return nodeRegistry().get(type)?.isContainer ?? false;
}

/** Returns true if the given node type can provide context content. */
export function isContextProvider(type: string): boolean {
  return nodeRegistry().get(type)?.providesContext ?? false;
}

/** Returns the content extractor function for the given node type, if registered. */
export function getContentExtractor(type: string): ((data: unknown) => string | null) | undefined {
  return nodeRegistry().get(type)?.extractContent;
}

/** Returns the attachment extractor (images, etc.) for the given node type, if registered. */
export function getAttachmentExtractor(
  type: string,
): ((data: unknown) => ContextAttachment[] | null) | undefined {
  return nodeRegistry().get(type)?.extractAttachments;
}
