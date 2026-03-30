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
}

export interface ContextItem {
  nodeId: string;
  nodeType: string;
  label: string;
  content: string;
}

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
  /** Current canvas zoom scale — useful for closing popups on zoom */
  canvasScale?: number;
}
