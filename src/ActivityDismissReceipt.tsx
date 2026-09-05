import { useLayoutEffect, useRef } from "react";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import { sessionDisplayTitle } from "./mobile/mobile-selectors.ts";
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
  return <section className="act-dismiss-receipt" aria-label="Dismissed activity receipts">
    <p role="status">Dismissed from Activity · {controller.dismissedReceipts.length} {controller.dismissedReceipts.length === 1 ? "activity" : "activities"}</p>
    {controller.dismissedReceipts.map((receipt) => {
      const id = activityEntryId(receipt);
      const current = sessions.find((session) => activityEntryId(session) === id);
      const latest = current && (current.reviewLifecycle?.lifecycleRevision ?? -1) >=
        (receipt.reviewLifecycle?.lifecycleRevision ?? -1) ? current : receipt;
      return <div key={id}><span>{sessionDisplayTitle(receipt)}</span>
        <button type="button" disabled={controller.pendingKeys.has(id)}
          aria-label={`Restore ${sessionDisplayTitle(receipt)} to Activity`}
          onClick={() => controller.sendLifecycle("reopen", latest)}>
          {controller.pendingKeys.has(id) ? "Restoring…" : "Restore"}
        </button>
      </div>;
    })}
    <small>Restore returns the entry to Activity. Canvas placement and discarded files are not restored.</small>
  </section>;
}
