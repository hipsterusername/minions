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
}

export interface ContextItem {
  nodeId: string;
  nodeType: string;
  label: string;
  content: string;
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

export interface NodeRenderProps {
  node: CanvasNode;
  isSelected: boolean;
  onUpdateData: (data: unknown) => void;
  socketSend?: (data: unknown) => void;
  socketSubscribe?: (fn: (msg: unknown) => void) => () => void;
  /** Returns text content from all context-protocol nodes connected to this node */
  getContextForNode?: () => ContextItem[];
  projectPath?: string;
  /** Callback to resize this node on the canvas */
  onResize?: (size: Size) => void;
  /** Callback to add a text response as a new markdown node on the canvas */
  onAddContentNode?: (content: string) => void;
  /** Callback to reveal (create or scroll-to) a minion node for a given session key */
  onRevealMinion?: (minionSessionKey: string) => void;
  /** Current canvas zoom scale — useful for closing popups on zoom */
  canvasScale?: number;
  /** True when a compatible node is being dragged over this node (drop target) */
  isDropTarget?: boolean;
  /** True when this node is currently being dragged by the user */
  isBeingDragged?: boolean;
}
