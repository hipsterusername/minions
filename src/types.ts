import type { SocketSubscribe } from "./use-socket.ts";

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

export interface CanvasNode<T = unknown> {
  id: string;
  type: string;
  position: Position;
  size: Size;
  data: T;
}

export type CanvasAction =
  | { type: "ADD_NODE"; node: CanvasNode }
  | { type: "REMOVE_NODE"; id: string }
  | { type: "MOVE_NODE"; id: string; position: Position }
  | { type: "RESIZE_NODE"; id: string; size: Size }
  | { type: "UPDATE_NODE_DATA"; id: string; data: unknown }
  | { type: "SET_NODES"; nodes: CanvasNode[] }
  | { type: "MOVE_GROUP"; moves: Array<{ id: string; position: Position }> };

export interface NodeTypeDefinition {
  type: string;
  label: string;
  defaultSize: Size;
  render: React.ComponentType<NodeRenderProps>;
  userCreatable?: boolean;
  /** When true, the node grows with content instead of using a fixed height */
  autoHeight?: boolean;
  /** Matches server-side AgentType.id — used to select the agent behavior */
  agentType?: string;
  /** Node types that this node owns/manages as children (e.g., leader owns ["minion", "render"]) */
  ownsChildrenOfType?: string[];
  /** When true, this node can provide context content (text) to connected nodes */
  providesContext?: boolean;
  /** When true, this node acts as a spatial container — nodes inside it are "grouped" */
  isContainer?: boolean;
  /** Function to extract text content from this node's data for context injection */
  extractContent?: (data: unknown) => string | null;
  /**
   * Extract non-text attachments (today: images) for multimodal context.
   * Return null or an empty array when the node has nothing binary to
   * contribute. Runs alongside `extractContent`; text and attachments
   * travel together inside the {@link ContextItem}.
   */
  extractAttachments?: (data: unknown) => ContextAttachment[] | null;
  /** Function to reset stale status fields when loading from persistence */
  sanitizeOnLoad?: (data: unknown) => unknown;
}

/**
 * A binary attachment that rides along with a {@link ContextItem}.
 * Today only images are supported; future phases may add PDFs / audio.
 *
 * `data` is a raw base64 string (no `data:` prefix). The server
 * forwards it to the SDK as an {@link ImageBlockParam} with a
 * Base64ImageSource source so the model sees the actual pixels, not
 * just a text description.
 */
export interface ContextAttachment {
  kind: "image";
  /** Original filename, if available — purely cosmetic. */
  filename?: string;
  /** IANA media type. Only JPEG/PNG/GIF/WebP are currently accepted by the API. */
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Pure base64 payload — no `data:...;base64,` prefix. */
  data: string;
}

export interface ContextItem {
  nodeId: string;
  nodeType: string;
  label: string;
  content: string;
  /**
   * Binary attachments contributed by this node. Omitted when empty.
   * Flows through `LeaderNode` into `create_session`'s `attachments`
   * field so the SDK can attach real image blocks to the user turn.
   */
  attachments?: ContextAttachment[];
}

// ── Adaptive thinking ────────────────────────────────────
//
// On Opus 4.7 adaptive is the *only* supported thinking mode and
// thinking.display defaults to "omitted" (so thinking blocks come
// back empty unless we explicitly opt into "summarized"). On 4.6
// and Sonnet 4.6 adaptive is recommended; on older models it is
// unsupported. The SDK passes these straight through to the
// Messages API.
//
// We deliberately do not expose budget_tokens / maxThinkingTokens —
// it is deprecated on 4.6+ and rejected on 4.7.

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingDisplay = "summarized" | "omitted";

export interface ThinkingConfig {
  /** When true, request adaptive thinking from the model.  */
  enabled: boolean;
  /** Soft guidance on how much thinking Claude should do. */
  effort: EffortLevel;
  /** Whether thinking summaries should be returned in the stream. */
  display: ThinkingDisplay;
}

export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  enabled: true,
  effort: "high",
  display: "summarized",
};

export const MINION_THINKING_CONFIG: ThinkingConfig = {
  enabled: true,
  effort: "medium",
  display: "summarized",
};

/** Payload emitted when a routine step spawns a Leader session on the server. */
export interface RoutineLeaderSpawnEvent {
  runId: string;
  phaseId: string;
  stepId: string;
  sessionKey: string;
}

export interface NodeRenderProps {
  node: CanvasNode;
  isSelected: boolean;
  onUpdateData: (data: unknown) => void;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?:
    | SocketSubscribe
    | ((fn: (msg: unknown) => void) => () => void)
    | undefined;
  /** Returns text content from all context-protocol nodes connected to this node */
  getContextForNode?: (() => ContextItem[]) | undefined;
  projectPath?: string | undefined;
  /** Callback to resize this node on the canvas */
  onResize?: ((size: Size) => void) | undefined;
  /** Callback to add a text response as a new markdown node on the canvas */
  onAddContentNode?: ((content: string) => void) | undefined;
  /** Callback to save a markdown node as a Kanban backlog card */
  onCreateKanbanCardFromMarkdown?: ((source: {
    nodeId: string;
    title: string;
    content: string;
  }) => void) | undefined;
  /** Callback to reveal (create or scroll-to) a minion node for a given session key */
  onRevealMinion?: ((minionSessionKey: string) => void) | undefined;
  /**
   * Callback invoked when this RoutineNode receives a `routine_step_leader_spawned`
   * event for its current runId. Canvas.tsx handles it by creating the leader node.
   */
  onSpawnLeaderChild?: ((event: RoutineLeaderSpawnEvent) => void) | undefined;
  /** Duplicate a Leader node's setup without prompt or chat history. */
  onDuplicateLeaderSetup?: (() => void) | undefined;
  /** Save a Leader node's setup as a reusable preset. */
  onSaveLeaderPreset?: ((input: {
    name: string;
    description?: string;
    systemPromptPrefix?: string;
  }) => boolean) | undefined;
  /** True when a compatible node is being dragged over this node (drop target) */
  isDropTarget?: boolean | undefined;
  /** True when this node is currently being dragged by the user */
  isBeingDragged?: boolean | undefined;
}
