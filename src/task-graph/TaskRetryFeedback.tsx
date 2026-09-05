import type { TaskGraphNodeView } from "./types.ts";
import type { TaskRetryReceipt } from "./use-task-retry-receipts.ts";

export function TaskRetryFeedback({ node, receipt, onRefresh }: {
  node: TaskGraphNodeView;
  receipt: TaskRetryReceipt | undefined;
  onRefresh: (() => void) | undefined;
}) {
  return <>
    <p role="status">{receipt?.pending ? receipt.accepted ? "Retry accepted · waiting to start" : "Retry requested…" : node.currentAttempt
      ? `Attempt ${node.currentAttempt.number} ${node.currentAttempt.state}` : "No current attempt"}</p>
    {receipt?.error && <p role="alert">{receipt.error} {onRefresh && <button onClick={onRefresh}>Refresh task state</button>}</p>}
  </>;
}
