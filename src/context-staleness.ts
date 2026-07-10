/**
 * Per-edge context staleness: is the downstream leader's view of an upstream
 * context source behind what the source currently holds?
 *
 * "Delivered" state comes from the target leader's persisted delivery ledger
 * (`LeaderData.contextDelivery`, written by LeaderNode on every send);
 * "current" state is recomputed from the source node. Pure module — no React,
 * no sockets — so EdgeRenderer/EdgeInspector can call it directly and tests
 * can drive it with plain objects.
 *
 * Staleness is informational, not actionable pressure: with staged delivery,
 * a stale edge means "this will be refreshed automatically with the next
 * message to the downstream leader".
 */

import type { CanvasNode } from "./types.ts";
import type { GraphEdge } from "./graph.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import { extractContextItem } from "./context-extraction.ts";
import { itemContentHash } from "./connected-context.ts";
import {
  resolveContextMode,
  resolveLeaderContextItem,
} from "./leader-context-mode.ts";

export interface EdgeContextStaleness {
  stale: boolean;
  /**
   * New transcript blocks upstream that the target has not received.
   * `null` when the source is not append-capable (dashboard mode, non-leader
   * sources) or the pending count cannot be derived.
   */
  pendingBlocks: number | null;
  /** Epoch ms of last delivery to the target, `null` if never delivered. */
  deliveredAt: number | null;
}

/**
 * Compute staleness for one context edge.
 *
 * Returns `null` when staleness does not apply: not a context edge, target
 * is not a leader with a live session (nothing has been delivered anywhere),
 * or the source currently contributes no context item.
 */
export function computeContextEdgeStaleness(
  edge: GraphEdge,
  sourceNode: CanvasNode,
  targetNode: CanvasNode,
): EdgeContextStaleness | null {
  if (edge.protocol !== "context") return null;
  if (targetNode.type !== "leader") return null;

  const targetData = targetNode.data as Partial<LeaderData> | undefined;
  if (!targetData?.sessionKey) return null;

  const mode = resolveContextMode(edge.contextMode);
  const item =
    sourceNode.type === "leader" && mode !== "dashboard"
      ? resolveLeaderContextItem(sourceNode, mode)
      : extractContextItem(sourceNode);
  if (!item) return null;

  const record = targetData.contextDelivery?.[sourceNode.id];
  if (!record) {
    // Session exists but this source has never been delivered — e.g. the
    // edge was connected after the session started, or the session predates
    // the delivery ledger. It ships in full with the next message.
    return {
      stale: true,
      pendingBlocks: item.blocks ? item.blocks.length : null,
      deliveredAt: null,
    };
  }

  if (record.hash === itemContentHash(item)) {
    return { stale: false, pendingBlocks: 0, deliveredAt: record.deliveredAt };
  }

  const pendingBlocks =
    item.blocks && record.version != null
      ? Math.max(item.blocks.length - record.version, 0)
      : null;

  return { stale: true, pendingBlocks, deliveredAt: record.deliveredAt };
}
