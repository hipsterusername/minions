import type { WorkItemDetailSnapshot } from "../../shared/work-item-contracts.ts";
import type { FixtureEntry } from "./ws-replay.ts";

/** Answer canonical launch/steering commands while preserving real UI routing. */
export function canonicalLeaderResponder(replay: (entries: FixtureEntry[]) => Promise<void>) {
  let revision = 0;
  let started = false;
  let changeMode: "live" | "worktree" = "live";
  return (value: unknown) => {
    const command = value as { type: string; requestId: string; changeMode?: "live" | "worktree" };
    if (!["create_work_item", "attach_work_item_surface", "continue_work_item", "start_work_item_run", "get_work_item"].includes(command.type)) return;
    if (command.type === "continue_work_item" || command.type === "start_work_item_run") started = true;
    if (command.changeMode) changeMode = command.changeMode;
    revision += 1;
    const result: WorkItemDetailSnapshot = {
      workItem: { id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Task",
        lifecycle: { runtimeState: started ? "working" : "draft", outcome: "none",
          resolution: "open", changeMode, integrationState: changeMode === "live" ? "live_clean" : "worktree_unprovisioned", lifecycleRevision: revision },
        waitKind: null, currentRunKey: started ? "run-1" : null, iteration: started ? 1 : 0,
        lastTransitionAt: revision, createdAt: 1, updatedAt: revision },
      bindings: [], currentRun: started ? { runKey: "run-1", workItemId: "work-1",
        runKind: "primary", parentRunKey: null, taskId: null, runNumber: 1, previousRunKey: null,
        providerSessionId: null, outcome: "none", startedAt: 1, endedAt: null, finalReport: null } : null,
      runs: [], nextCursor: null,
    };
    queueMicrotask(() => { void replay([{ message: {
      type: "work_item_response", command: command.type as "create_work_item",
      requestId: command.requestId, success: true, result,
    } }]); });
  };
}
