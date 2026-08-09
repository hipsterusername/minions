import type { WorkItemRunSnapshot } from "../shared/work-item-contracts.ts";

/**
 * Run history is about user-visible iterations, not child/minion runs. Keep
 * the current run in the live conversation and return every earlier primary
 * run newest-first for the history picker.
 */
export function previousPrimaryRuns(
  runs: readonly WorkItemRunSnapshot[],
  currentRunKey: string,
): WorkItemRunSnapshot[] {
  return runs
    .filter((run) => run.runKind === "primary" && run.runKey !== currentRunKey)
    .sort((a, b) => b.startedAt - a.startedAt || b.runKey.localeCompare(a.runKey));
}
