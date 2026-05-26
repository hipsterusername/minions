import type { PortInfo } from "./components/PortDot.tsx";

/**
 * What should happen when the user releases a connection-drag.
 *
 * The window-level mouseup handler races with the port-level mouseup
 * (PortDot.onMouseUp). When the drop lands on an existing port, the
 * port-level handler runs first and creates the edge — the window-level
 * handler must then NO-OP, or it would incorrectly fall through to its
 * "dropped on empty canvas" branch (offering to spawn a new leader or
 * showing the dashboard-drop action menu).
 *
 * This pure function captures that priority decision so it can be
 * unit-tested without rendering the canvas.
 */
export type ConnectionDropAction =
  | { kind: "consumed-by-port" }
  | { kind: "snap-connect"; snap: PortInfo }
  | { kind: "show-dashboard-menu" }
  | { kind: "create-default-leader" }
  | { kind: "noop" };

export interface ConnectionDropInput {
  /** The port the drag started from. */
  source: PortInfo;
  /** Nearest valid port within snap radius at the moment of release. */
  snapTarget: PortInfo | null;
  /** True if a port-level mouseup already created the edge for this drop. */
  consumedByPort: boolean;
  /**
   * The Leader contract's input port id that is protocol-compatible with the
   * source. When null, no implicit "create leader and connect" is possible.
   */
  compatibleLeaderInputPortId: string | null;
}

export function decideConnectionDropAction(
  opts: ConnectionDropInput,
): ConnectionDropAction {
  if (opts.consumedByPort) {
    return { kind: "consumed-by-port" };
  }
  if (opts.snapTarget) {
    return { kind: "snap-connect", snap: opts.snapTarget };
  }
  if (opts.source.direction !== "output") {
    return { kind: "noop" };
  }
  if (!opts.compatibleLeaderInputPortId) {
    return { kind: "noop" };
  }
  if (opts.source.nodeType === "render" && opts.source.protocol === "context") {
    return { kind: "show-dashboard-menu" };
  }
  return { kind: "create-default-leader" };
}
