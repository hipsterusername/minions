import { FolderInput, GripVertical, LayoutDashboard, Layers } from "lucide-react";
import { ViewportOverlay } from "./components/ViewportOverlay.tsx";
import { zoneLeaderLabel, zoneLeaderState } from "./canvas-zones.ts";
import type { CanvasNode, Position } from "./types.ts";
import "./leader-drag.css";

export function LeaderDragCard({ node, pointer, zoneName, count = 1 }: {
  node: CanvasNode; pointer: Position; zoneName?: string | undefined; count?: number | undefined;
}) {
  const state = count > 1 ? "Moving together" : zoneLeaderState(node);
  return <ViewportOverlay zIndex={1100}>
    <div className="leader-drag-anchor" style={{
      left: Math.max(8, Math.min(pointer.x + 18, window.innerWidth - 272)),
      top: Math.max(8, Math.min(pointer.y + 18, window.innerHeight - 116)),
    }}>
      <div className="leader-drag-card" data-over-zone={!!zoneName} role="status" aria-live="polite">
        <div className="leader-drag-card-main">
          <span className="leader-drag-icon"><Layers size={18} strokeWidth={1.6} /></span>
          <div className="leader-drag-title"><span>{count > 1 ? "Group" : "Leader"}</span>
            <strong>{count > 1 ? `${count} nodes` : zoneLeaderLabel(node)}</strong></div>
          <GripVertical size={15} className="leader-drag-grip" />
        </div>
        <div className="leader-drag-state"><i data-attention={state === "Needs input" || state === "Error"} />{state}</div>
        <div className="leader-drag-destination" key={zoneName ?? "canvas"}>
          {zoneName ? <FolderInput size={13} /> : <LayoutDashboard size={13} />}
          <span>{zoneName ? `Release into ${zoneName}` : "Release to place on canvas"}</span>
        </div>
      </div>
    </div>
  </ViewportOverlay>;
}
