import { describe, expect, it, vi } from "vitest";
import type { WorkItemSnapshot } from "../../../shared/work-item-contracts.ts";
import { applyCanvasWorkItemSnapshot, canonicalPromptCommand, selectCanvasChangeMode,
  formatCanvasWorkItemStatus, selectCanvasWorkItem } from "./work-item.ts";
import { LEADER_DEFAULT_DATA } from "./types.ts";
import { extractLeaderCore } from "./session-context.ts";
import { preserveOptimisticUserMessages, sessionStreamReducer } from "../../session-stream.ts";

function item(over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot {
  return {
    id: "work-1", projectId: "project", projectPath: "/repo", title: "Task",
    lifecycle: { runtimeState: "inactive", outcome: "completed", resolution: "open",
      changeMode: "live", integrationState: "live_clean", lifecycleRevision: 2 },
    waitKind: null, currentRunKey: "run-1", iteration: 1,
    lastTransitionAt: 2,
    createdAt: 1, updatedAt: 2, ...over,
  };
}

describe("Canvas canonical work-item projection", () => {
  it("prefers the canonical change mode over the legacy leader setup flag", () => {
    expect(selectCanvasChangeMode({ worktreeIsolation: true,
      workItemSnapshot: item() })).toBe("live");
    expect(selectCanvasChangeMode({ worktreeIsolation: false,
      workItemSnapshot: item({ lifecycle: { ...item().lifecycle, changeMode: "worktree",
        integrationState: "worktree_active" } }) })).toBe("worktree");
    expect(selectCanvasChangeMode({ worktreeIsolation: false })).toBe("live");
  });

  it("uses the same shared lifecycle label as other surfaces", () => {
    expect(selectCanvasWorkItem(item())?.presentation.label).toBe("Ready for review");
    expect(selectCanvasWorkItem(item({ lifecycle: { ...item().lifecycle,
      runtimeState: "waiting", outcome: "none" }, waitKind: "decision" }))?.presentation.label)
      .toBe("Decision needed");
  });

  it("distinguishes inactive interruptions from deliberate stops on canvas", () => {
    const stopped = selectCanvasWorkItem(item({ lifecycle: { ...item().lifecycle,
      outcome: "stopped" } }));
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.presentation.label).toBe("Stopped");
    const inactive = item({ lifecycle: { ...item().lifecycle,
      outcome: "interrupted" } });
    expect(selectCanvasWorkItem(inactive)?.status).toBe("inactive");
    expect(formatCanvasWorkItemStatus(inactive, undefined)).toBe("Inactive");
  });

  it("keeps one work item across distinct repeated iteration keys", () => {
    const first = applyCanvasWorkItemSnapshot({ workItemId: null }, item());
    const secondItem = item({ currentRunKey: "run-2", iteration: 2,
      lifecycle: { ...item().lifecycle, runtimeState: "starting", outcome: "none",
        lifecycleRevision: 3 } });
    const second = applyCanvasWorkItemSnapshot(first, secondItem);
    expect(second.workItemId).toBe("work-1");
    expect([first.currentRunKey, second.currentRunKey]).toEqual(["run-1", "run-2"]);
  });

  it("sends one continuation intent for every lifecycle state", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    expect(canonicalPromptCommand(item(), "again")).toMatchObject({
      type: "continue_work_item", workItemId: "work-1", expectedCurrentRunKey: "run-1",
    });
    const waiting = item({ lifecycle: { ...item().lifecycle, runtimeState: "waiting", outcome: "none" },
      waitKind: "decision" });
    expect(canonicalPromptCommand(waiting, "answer")).toMatchObject({
      type: "continue_work_item", expectedCurrentRunKey: "run-1",
    });
    const fileWait = item({ lifecycle: { ...item().lifecycle, runtimeState: "waiting", outcome: "none" },
      waitKind: "file_conflict" });
    expect(canonicalPromptCommand(fileWait, "answer").type).toBe("continue_work_item");
  });

  it("does not restore previous user turns when the next iteration syncs", () => {
    const previous = { ...LEADER_DEFAULT_DATA, sessionKey: "run-1", workItemId: "work-1",
      workItemSnapshot: item(), streamingText: "Old partial response", streamingBlockIndex: null, totalCost: 2, turns: 4,
      messages: [{ id: "old-user", role: "user" as const, content: "Previous instruction", timestamp: 1 }] };
    const next = applyCanvasWorkItemSnapshot(previous, item({ currentRunKey: "run-2",
      iteration: 2, lifecycle: { ...item().lifecycle, lifecycleRevision: 3 } }));
    expect(next).toMatchObject({ sessionKey: "run-2", messages: [], streamingText: "",
      totalCost: 0, turns: 0 });
    const synced = sessionStreamReducer(extractLeaderCore(next), { type: "sync_response", sessionKey: "run-2",
      found: true, events: [{ type: "sdk_event", sessionKey: "run-2", timestamp: 2,
        event: { kind: "text", role: "user", text: "Next instruction" } }] }, "lm");
    expect(preserveOptimisticUserMessages(next.messages, synced.messages).map(m => m.content))
      .toEqual(["Next instruction"]);
    expect(previous.messages).toHaveLength(1);
  });

  it("preserves local user turns for same-run updates and the initial launch", () => {
    const messages = [{ id: "user", role: "user" as const, content: "Current instruction", timestamp: 1 }];
    for (const sessionKey of [null, "run-1"]) {
      const next = applyCanvasWorkItemSnapshot({ ...LEADER_DEFAULT_DATA, sessionKey, messages }, item());
      expect(next.sessionKey).toBe("run-1");
      expect(next.messages).toBe(messages);
    }
  });

  it("ignores a stale snapshot so a late event cannot roll the node back", () => {
    const current = { workItemId: "work-1", currentRunKey: "run-2",
      workItemSnapshot: item({ currentRunKey: "run-2", lifecycle: {
        ...item().lifecycle, lifecycleRevision: 5 } }) };
    expect(applyCanvasWorkItemSnapshot(current, item()).currentRunKey).toBe("run-2");
  });


});
