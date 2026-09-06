import { useLayoutEffect, useRef } from "react";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import { UndoNotification } from "./components/UndoNotification.tsx";
import { activityEntryId } from "./use-work-items.ts";
import type { useActivityLifecycle } from "./use-activity-lifecycle.ts";
import "./activity-dismiss-receipt.css";

export function useActivityRemovalFocus() {
  const rootRef = useRef<HTMLDivElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (focused.current && !focused.current.isConnected && document.activeElement === document.body) {
      const next = rootRef.current?.querySelector<HTMLElement>(
        '.act-triage-main, .act-card-main',
      ) ?? rootRef.current?.querySelector<HTMLElement>(".act-dismiss-receipt button, .act-scope-select");
      next?.focus({ preventScroll: true });
      focused.current = next ?? null;
    }
  });
  return { ref: rootRef, onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => {
    focused.current = event.target as HTMLElement;
  } };
}

export function ActivityDismissReceipt({ controller, sessions }: {
  controller: ReturnType<typeof useActivityLifecycle>;
  sessions: readonly MobileSessionInfo[];
}) {
  if (!controller.dismissedReceipts.length) return null;
  const receipts = controller.dismissedReceipts;
  const restoring = receipts.some(receipt => controller.pendingKeys.has(activityEntryId(receipt)));
  return <UndoNotification
    className="act-dismiss-receipt"
    message={`Dismissed from Activity · ${receipts.length} ${receipts.length === 1 ? "activity" : "activities"}`}
    undoDisabled={restoring}
    dismissLabel="Dismiss activity notification"
    onDismiss={controller.clearDismissedReceipts}
    onUndo={() => {
      for (const receipt of receipts) {
        const current = sessions.find(session => activityEntryId(session) === activityEntryId(receipt));
        const latest = current && (current.reviewLifecycle?.lifecycleRevision ?? -1) >=
          (receipt.reviewLifecycle?.lifecycleRevision ?? -1) ? current : receipt;
        controller.sendLifecycle("reopen", latest);
      }
    }}
  />;
}
