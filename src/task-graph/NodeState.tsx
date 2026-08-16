import type { TaskGraphNodeView } from "./types.ts";

export function NodeState({ node, compact = false }: { node: TaskGraphNodeView; compact?: boolean }) {
  const attempt = node.currentAttempt?.state ?? "none";
  return (
    <span
      className={`tg-node-state tg-logical--${node.logicalState} tg-attempt--${attempt}`}
      aria-label={`Logical ${node.logicalState}; attempt ${attempt}; verification ${node.verification.state}${node.blocker && node.blocker.category !== "none" ? `; blocker ${node.blocker.category}` : ""}`}
    >
      <span className="tg-node-state__fill">{compact ? "" : node.logicalState}</span>
      <span className={`tg-verification tg-verification--${node.verification.state}`} title={`Verification: ${node.verification.state}`} aria-hidden="true">
        {node.verification.state === "passed" ? "✓" : node.verification.state === "waived" ? "◇" : "♢"}
      </span>
      {node.blocker && node.blocker.category !== "none" && <span className="tg-blocker">{node.blocker.category}</span>}
    </span>
  );
}
