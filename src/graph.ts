/**
 * Graph Document — the formal interface contract between nodes.
 *
 * Every node on the canvas declares ports (typed connection points).
 * Edges connect an output port on one node to an input port on another.
 * Messages flow through edges according to the port's protocol.
 *
 * This file defines the type system, not the runtime. The runtime
 * lives in graph-runtime.ts and the visual rendering in EdgeRenderer.
 */

// ── Port protocols ──────────────────────────────────────
// Each protocol defines the shape of messages that flow through it.

export interface TaskAssignment {
  taskId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  assignedAt: number;
}

export interface ContextPayload {
  sourceNodeId: string;
  sourceNodeType: string;
  label: string;
  content: string;
  updatedAt: number;
}

// Union of all messages that can flow through edges
export type EdgeMessage =
  | { protocol: "task-assignment"; payload: TaskAssignment }
  | { protocol: "context"; payload: ContextPayload };

// ── Port definitions ────────────────────────────────────

export type PortDirection = "input" | "output";

export type PortLifecycleState = "open" | "locked";

export interface PortDefinition {
  id: string;
  label: string;
  direction: PortDirection;
  protocol: EdgeMessage["protocol"];
  maxConnections: number;
  /** Fixed vertical position as a ratio (0–1) of node height. Overrides even-spacing. */
  anchorY?: number;
  /**
   * Optional state-aware guard for this port. Called with the owning node's
   * data at connection time. Return "locked" to reject new connections,
   * "open" to allow them. When omitted, the port is always open.
   */
  lifecycle?: (nodeData: unknown) => PortLifecycleState;
}

// ── Node interface contracts ────────────────────────────
// Each node type declares which ports it exposes.

export interface NodeInterfaceContract {
  nodeType: string;
  label: string;
  description: string;
  ports: PortDefinition[];
}

export const LEADER_CONTRACT: NodeInterfaceContract = {
  nodeType: "leader",
  label: "Leader",
  description:
    "Orchestrator session that decomposes work into tasks " +
    "and assigns them to connected Minion nodes.",
  ports: [
    {
      id: "task-out",
      label: "Assign Task",
      direction: "output",
      protocol: "task-assignment",
      maxConnections: 10,
      anchorY: 0.2,
    },
    {
      id: "context-in",
      label: "Context",
      direction: "input",
      protocol: "context",
      maxConnections: 20,
      anchorY: 0.95,
      /**
       * Context port locks once a session is started — context is baked into
       * the first prompt and cannot be changed after that.
       */
      lifecycle: (nodeData: unknown): PortLifecycleState => {
        const data = nodeData as { sessionKey: string | null } | undefined;
        return data?.sessionKey ? "locked" : "open";
      },
    },
  ],
};

export const MINION_CONTRACT: NodeInterfaceContract = {
  nodeType: "minion",
  label: "Minion",
  description:
    "Worker session that receives task assignments from a Leader, " +
    "executes them, and reports status and results back.",
  ports: [
    {
      id: "task-in",
      label: "Receive Task",
      direction: "input",
      protocol: "task-assignment",
      maxConnections: 1,
      anchorY: 0.5,
    },
  ],
};

// ── Context provider ───────────────────────────────────

export const CONTEXT_OUT_PORT: PortDefinition = {
  id: "context-out",
  label: "Context",
  direction: "output",
  protocol: "context",
  maxConnections: 10,
};

export const CONTEXT_PROVIDER_CONTRACT: NodeInterfaceContract = {
  nodeType: "context-provider",
  label: "Context Provider",
  description:
    "Provides text context that can be connected to Leader nodes.",
  ports: [CONTEXT_OUT_PORT],
};

// ── Context group ─────────────────────────────────────

export const CONTEXT_GROUP_CONTRACT: NodeInterfaceContract = {
  nodeType: "context-group",
  label: "Context Group",
  description:
    "A visual frame that groups context nodes by spatial containment. " +
    "Place Markdown, Note, or File Viewer nodes inside the frame, " +
    "then connect the group's output to a Leader.",
  ports: [CONTEXT_OUT_PORT],
};

// ── Edge ────────────────────────────────────────────────

export interface GraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  protocol: EdgeMessage["protocol"];
}

// ── Graph document ──────────────────────────────────────
// The full serializable state of all edges on the canvas.

export interface GraphDocument {
  edges: GraphEdge[];
}

// ── Contract registry ───────────────────────────────────

const contracts = new Map<string, NodeInterfaceContract>();

export function registerContract(c: NodeInterfaceContract): void {
  contracts.set(c.nodeType, c);
}

export function getContract(
  nodeType: string,
): NodeInterfaceContract | undefined {
  return contracts.get(nodeType);
}

export function getPortDef(
  nodeType: string,
  portId: string,
): PortDefinition | undefined {
  return getContract(nodeType)?.ports.find((p) => p.id === portId);
}

export function getAllContracts(): NodeInterfaceContract[] {
  return Array.from(contracts.values());
}

// Register built-in contracts
registerContract(LEADER_CONTRACT);
registerContract(MINION_CONTRACT);
registerContract(CONTEXT_PROVIDER_CONTRACT);
registerContract(CONTEXT_GROUP_CONTRACT);

// ── Validation ──────────────────────────────────────────

export function canConnect(
  sourceType: string,
  sourcePortId: string,
  targetType: string,
  targetPortId: string,
): boolean {
  const srcPort = getPortDef(sourceType, sourcePortId);
  const tgtPort = getPortDef(targetType, targetPortId);
  if (!srcPort || !tgtPort) return false;
  if (srcPort.direction !== "output") return false;
  if (tgtPort.direction !== "input") return false;
  return srcPort.protocol === tgtPort.protocol;
}

/**
 * Generic lifecycle guard for any port.
 *
 * Consults the port's optional `lifecycle` callback to determine whether
 * it is currently accepting new connections. Returns true (open) when:
 * - The port has no lifecycle callback (always open), or
 * - The lifecycle callback returns "open".
 */
export function isPortOpen(
  nodeType: string,
  portId: string,
  nodeData: unknown,
): boolean {
  const port = getPortDef(nodeType, portId);
  if (!port?.lifecycle) return true;
  return port.lifecycle(nodeData) === "open";
}
