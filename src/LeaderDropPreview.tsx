import type { CanvasNode, Position } from "./types.ts";
import "./leader-drag.css";

export function LeaderDropPreview({ nodes, moves, overZone }: {
  nodes: CanvasNode[]; moves: { id: string; position: Position }[]; overZone: boolean;
}) {
  if (!moves.length || overZone) return null;
  const members = moves.flatMap(move => {
    const node = nodes.find(n => n.id === move.id);
    return node ? [{ ...move.position, ...node.size }] : [];
  });
  if (!members.length) return null;
  const left = Math.min(...members.map(n => n.x));
  const top = Math.min(...members.map(n => n.y));
  const width = Math.max(...members.map(n => n.x + n.width)) - left;
  const height = Math.max(...members.map(n => n.y + n.height)) - top;
  return <div className="leader-drop-preview" aria-hidden="true">
    <div className="leader-drop-footprint" data-primary="true" style={{ left, top, width, height }}>
      <span>{members.length > 1 ? `Place ${members.length} nodes here` : "Place here"}</span>
    </div>
  </div>;
}
