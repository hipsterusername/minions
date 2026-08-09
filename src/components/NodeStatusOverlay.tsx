import { useEffect, useMemo, useRef, useState } from "react";

import {
  formatStatusDuration,
  reconcileStatusDurations,
  type StatusEntry,
} from "../canvas/status-duration.ts";
import type { CanvasNode, CanvasTransform } from "../types.ts";
import type { MinionData } from "../nodes/MinionNode.tsx";
import type { LeaderData } from "../nodes/leader/types.ts";
import { selectCanvasWorkItem } from "../nodes/leader/work-item.ts";
import { STATUS_COLORS as SESSION_STATUS_COLORS, COLORS } from "../palette.ts";

interface NodeStatusOverlayProps {
  nodes: CanvasNode[];
  transform: CanvasTransform;
  visible: boolean;
}

// Map every leader/minion status onto the theme's dedicated `--status-*`
// semantic tokens (via the canonical palette) so the overlay tracks the active
// theme — including the WCAG-adjusted light variants and the intentional
// running (sky) vs. completed (emerald) distinction. `completed` is
// leader-only, so it is added on top of the shared session-status set.
const STATUS_COLOR_BY_STATUS: Record<string, string> = {
  ...SESSION_STATUS_COLORS,
  completed: "var(--status-success)",
};

const DEFAULT_STATUS_COLOR = "var(--text-muted)";

export function getOverlayNodes(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.filter((node) => node.type === "leader" || node.type === "minion");
}

export function resolveLeaderTitle(
  node: CanvasNode,
  nodesById: Map<string, CanvasNode>,
): string {
  const leaderNode =
    node.type === "minion"
      ? nodesById.get(((node.data as Partial<MinionData>).leaderId ?? "") as string)
      : node;

  const taskName =
    leaderNode?.type === "leader"
      ? (leaderNode.data as Partial<LeaderData>).taskName
      : null;
  return typeof taskName === "string" && taskName.trim().length > 0
    ? taskName.trim()
    : "Leader";
}

function readNodeStatus(node: CanvasNode): string {
  const data = node.data as Partial<LeaderData | MinionData>;
  const rawStatus =
    typeof data.status === "string" && data.status.length > 0
      ? data.status
      : "disconnected";
  // Leaders display a work-item-snapshot-derived status in their node header
  // (LeaderNode's `displayStatus`). The zoomed-out overlay must show the exact
  // same value — read it through the same projection instead of the raw
  // `data.status` field, so the two surfaces stay in sync 1:1. Minions have no
  // work-item snapshot and keep their raw status.
  if (node.type === "leader") {
    return (
      selectCanvasWorkItem((data as Partial<LeaderData>).workItemSnapshot)
        ?.status ?? rawStatus
    );
  }
  return rawStatus;
}

export function NodeStatusOverlay({
  nodes,
  transform,
  visible,
}: NodeStatusOverlayProps) {
  const durationsRef = useRef<Map<string, StatusEntry>>(new Map());
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNowTick((tick) => tick + 1);
    }, 30_000);

    return () => window.clearInterval(intervalId);
  }, [visible]);

  const overlayNodes = useMemo(() => getOverlayNodes(nodes), [nodes]);
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const now = Date.now();

  if (!visible) {
    return null;
  }

  durationsRef.current = reconcileStatusDurations(
    durationsRef.current,
    overlayNodes.map((node) => ({ id: node.id, status: readNodeStatus(node) })),
    now,
  );

  return (
    <div
      data-testid="node-status-overlay"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 40,
      }}
    >
      {overlayNodes.map((node) => {
        const status = readNodeStatus(node);
        const statusColor = STATUS_COLOR_BY_STATUS[status] ?? DEFAULT_STATUS_COLOR;
        const entry = durationsRef.current.get(node.id);
        const left = node.position.x * transform.scale + transform.x;
        const top = node.position.y * transform.scale + transform.y;
        const width = node.size.width * transform.scale;
        const height = node.size.height * transform.scale;

        return (
          <div
            key={node.id}
            data-testid={`node-status-overlay-item-${node.id}`}
            style={{
              position: "absolute",
              left,
              top,
              width,
              height,
              boxSizing: "border-box",
              display: "grid",
              placeItems: "center",
              padding: 8,
              border: `3px solid ${statusColor}`,
              borderRadius: 8,
              background: `color-mix(in srgb, ${statusColor} 14%, transparent)`,
              pointerEvents: "none",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: "min(260px, 92%)",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                padding: "8px 10px",
                borderRadius: 6,
                background: "color-mix(in srgb, var(--bg-surface) 88%, transparent)",
                boxShadow: COLORS.shadowLg,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  maxWidth: "100%",
                  color: statusColor,
                  fontFamily: "var(--font-mono)",
                  fontSize: 14,
                  fontWeight: 800,
                  lineHeight: 1.1,
                  textTransform: "uppercase",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {status.toUpperCase()}
              </div>
              <div
                style={{
                  maxWidth: "100%",
                  color: "var(--text-primary)",
                  fontSize: 15,
                  fontWeight: 800,
                  lineHeight: 1.2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {resolveLeaderTitle(node, nodesById)}
              </div>
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.15,
                }}
              >
                {formatStatusDuration(entry?.since ?? now, now)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
