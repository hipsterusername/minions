import { useState, type UIEvent } from "react";
import { getVirtualRange, whyNotRunning, WORK_QUEUE_ROW_HEIGHT } from "./model.ts";
import { NodeState } from "./NodeState.tsx";
import type { TaskGraphNodeView } from "./types.ts";

const VIEWPORT_HEIGHT = 348;

export function WorkQueue({ nodes, onSelect }: { nodes: TaskGraphNodeView[]; onSelect: (id: string) => void }) {
  const [scrollTop, setScrollTop] = useState(0);
  const range = getVirtualRange(nodes.length, scrollTop, VIEWPORT_HEIGHT);
  const visible = nodes.slice(range.start, range.end);
  const onScroll = (event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop);
  return (
    <div className="tg-queue" role="region" aria-label="Windowed work queue" style={{ height: VIEWPORT_HEIGHT }} onScroll={onScroll}>
      <div style={{ height: range.totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${range.offset}px)` }}>
          {visible.map((node) => (
            <button key={node.id} type="button" className="tg-queue-row" style={{ height: WORK_QUEUE_ROW_HEIGHT }} onClick={() => onSelect(node.id)}>
              <NodeState node={node} compact />
              <span className="tg-queue-row__main"><strong>{node.title}</strong><small>{whyNotRunning(node)}</small></span>
              <span className="tg-queue-row__meta">P{node.priority} · age {formatAge(node.queueAgeMs)}<small>{node.currentAttempt?.executor ?? "unassigned"}</small></span>
              <span className="tg-queue-row__meta">{node.currentAttempt ? `#${node.currentAttempt.number} ${node.currentAttempt.state}` : "no attempt"}<small>{node.backoffUntil ? `backoff until ${new Date(node.backoffUntil).toLocaleTimeString()}` : `$${node.costUsd.toFixed(2)}`}</small></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatAge(ms?: number) {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}
