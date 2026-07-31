import { describe, expect, it } from "vitest";

import type {
  WorkItemDetailSnapshot,
  WorkItemSnapshot,
} from "../shared/work-item-contracts.ts";
import { initialWorkItemLifecycle } from "../shared/work-item-lifecycle.ts";
import { decideConflictRecovery } from "./work-item-retry-policy.ts";

function detail(
  runtimeState: WorkItemSnapshot["lifecycle"]["runtimeState"],
  overrides: Partial<WorkItemSnapshot> = {},
): WorkItemDetailSnapshot {
  const workItem: WorkItemSnapshot = {
    id: "work-1",
    projectId: "project-1",
    projectPath: "/repo",
    title: "Task",
    lifecycle: {
      ...initialWorkItemLifecycle(),
      runtimeState,
      lifecycleRevision: 4,
    },
    waitKind: null,
    currentRunKey: "run-1",
    iteration: 1,
    lastTransitionAt: 4,
    createdAt: 1,
    updatedAt: 4,
    ...overrides,
  };
  return {
    workItem,
    bindings: [],
    currentRun: null,
    runs: [],
    nextCursor: null,
  };
}

const base = {
  code: "conflict",
  attempt: 1,
  projectId: "project-1",
  workItemId: "work-1",
  prompt: "Continue",
  requestId: "retry-2",
};

describe("decideConflictRecovery", () => {
  it("retries with fresh fences via the unified continuation command", () => {
    const latest = detail("waiting", { waitKind: "decision" });
    const decision = decideConflictRecovery({ ...base, latest });

    expect(decision).toEqual({
      kind: "retry",
      command: {
        type: "continue_work_item",
        requestId: "retry-2",
        workItemId: "work-1",
        prompt: "Continue",
        expectedLifecycleRevision: 4,
        expectedCurrentRunKey: "run-1",
      },
    });
  });

  it("retries via continue_work_item when the item is inactive", () => {
    const latest = detail("inactive");
    const decision = decideConflictRecovery({ ...base, latest });

    expect(decision).toEqual({
      kind: "retry",
      command: {
        type: "continue_work_item",
        requestId: "retry-2",
        workItemId: "work-1",
        prompt: "Continue",
        expectedLifecycleRevision: 4,
        expectedCurrentRunKey: "run-1",
      },
    });
  });

  it.each(["starting", "working"] as const)(
    "converges when another surface already moved the item to %s",
    (runtimeState) => {
      expect(decideConflictRecovery({
        ...base,
        latest: detail(runtimeState),
      })).toEqual({ kind: "converge" });
    },
  );

  it.each([
    ["non-conflict", { ...base, code: "invalid_transition", latest: detail("inactive") }],
    ["attempts-exhausted", { ...base, attempt: 3, latest: detail("inactive") }],
    ["identity-mismatch", {
      ...base,
      latest: detail("inactive", { id: "other-work" }),
    }],
    ["unsupported-state", { ...base, latest: detail("waiting") }],
    ["missing-latest", { ...base, latest: null }],
  ] as const)("gives up with %s", (reason, input) => {
    expect(decideConflictRecovery(input)).toEqual({ kind: "give-up", reason });
  });
});
