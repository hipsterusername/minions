/**
 * RoutineConnectors — thin SVG lines from a RoutineNode to each of its
 * spawned Leader children, coloured by the phase's run state.
 *
 * Rendered inside the world-transform div in Canvas.tsx so coordinates are
 * already in world (canvas) space.  The SVG element uses `overflow: visible`
 * so lines that extend outside the notional 1×1 viewport are not clipped.
 */

import type { CanvasNode } from "../types.ts";
import type { LeaderData } from "../nodes/LeaderNode.tsx";
import type { RoutineNodeData } from "../nodes/RoutineNode.tsx";

const PHASE_STATE_COLORS: Record<string, string> = {
  pending: "var(--text-muted)",
  running: "var(--info-color)",
  success: "var(--status-success)",
  error: "var(--status-error)",
  skipped: "var(--text-muted)",
};

interface Props {
  nodes: CanvasNode[];
}

export function RoutineConnectors({ nodes }: Props) {
  const paths: React.ReactNode[] = [];

  const routineNodes = nodes.filter((n) => n.type === "routine");
  if (routineNodes.length === 0) return null;

  for (const routineNode of routineNodes) {
    const rd = routineNode.data as RoutineNodeData;
    if (!rd.runId) continue;

    const children = nodes.filter(
      (n) =>
        n.type === "leader" &&
        (n.data as LeaderData).routineRunId === rd.runId,
    );
    if (children.length === 0) continue;

    const phases = rd.snapshot?.phases ?? [];

    for (const leader of children) {
      const ld = leader.data as LeaderData;
      const phase = phases.find((p) => p.phaseId === ld.routinePhaseId);
      const color =
        PHASE_STATE_COLORS[phase?.state ?? "pending"] ??
        "var(--text-muted)";

      const x1 = routineNode.position.x + routineNode.size.width;
      const y1 = routineNode.position.y + routineNode.size.height / 2;
      const x2 = leader.position.x;
      const y2 = leader.position.y + leader.size.height / 2;
      const cx = Math.abs(x2 - x1) * 0.4;
      const d = `M ${x1} ${y1} C ${x1 + cx} ${y1}, ${x2 - cx} ${y2}, ${x2} ${y2}`;

      paths.push(
        <path
          key={`${routineNode.id}-${leader.id}`}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeOpacity={0.45}
          strokeDasharray="4 3"
        />,
      );
    }
  }

  if (paths.length === 0) return null;

  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        overflow: "visible",
        pointerEvents: "none",
        width: 1,
        height: 1,
        zIndex: 0,
      }}
    >
      {paths}
    </svg>
  );
}
