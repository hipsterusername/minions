import { describe, expect, it, vi } from "vitest";
import { WorkItemServiceError, type WorkItemService } from "../../server/work-item-service.ts";
import { dispatchCommand } from "../../server/commands/index.ts";
import {
  workItemDetailSnapshotSchema,
  type WorkItemDetailSnapshot,
} from "../../shared/work-item-contracts.ts";
import { initialWorkItemLifecycle } from "../../shared/work-item-lifecycle.ts";
import { errorFromWorkItemResponse } from "../../src/nodes/leader/work-item.ts";
import { setup, type CapturedEnvelope } from "../support/server-command-harness.ts";

const detail: WorkItemDetailSnapshot = {
  workItem: {
    id: "work-1", projectId: "project-1", projectPath: "/repo", title: "Task",
    lifecycle: initialWorkItemLifecycle(), waitKind: null, currentRunKey: null, iteration: 0,
    workflowColumnId: "backlog", workflowRank: "a", workflowRevision: 0,
    card: { description: "", subtasks: [], context: "", priority: "medium",
      model: "", permissionMode: "auto", worktreeIsolation: false, skillIds: [],
      skillValues: {}, linkedContextNodeIds: [] },
    lastTransitionAt: 1, createdAt: 1, updatedAt: 1,
  },
  bindings: [], currentRun: null, runs: [], nextCursor: null,
};

const archiveCommand = {
  type: "archive_work_item" as const,
  requestId: "request-1",
  workItemId: "work-1",
  expectedLifecycleRevision: 1,
  expectedCurrentRunKey: null,
};

function rejectingService(error: unknown): WorkItemService {
  return {
    archive: vi.fn(async () => { throw error; }),
  } as unknown as WorkItemService;
}

async function dispatchFailure(error?: unknown): Promise<CapturedEnvelope> {
  const harness = setup();
  if (error !== undefined) harness.ctx.workItems = rejectingService(error);
  dispatchCommand(harness.ctx, archiveCommand, harness.ws);
  await vi.waitFor(() => expect(harness.wsSent).toHaveLength(1));
  return harness.wsSent[0]!;
}

function payloadOf(envelope: CapturedEnvelope): Record<string, unknown> {
  const { topic: _topic, ...payload } = envelope;
  return payload;
}

describe("work_item_response failure envelope contract", () => {
  it("serializes typed conflicts with the authoritative detail snapshot", async () => {
    const envelope = await dispatchFailure(
      new WorkItemServiceError("conflict", "stale revision", detail),
    );

    expect(envelope.topic).toBe("work-item:work-1");
    expect(payloadOf(envelope)).toEqual({
      type: "work_item_response",
      command: "archive_work_item",
      requestId: "request-1",
      success: false,
      error: "stale revision",
      code: "conflict",
      latest: detail,
    });
    expect(workItemDetailSnapshotSchema.safeParse(envelope.latest).success).toBe(true);
  });

  it("normalizes unknown errors to an internal failure without a snapshot", async () => {
    const envelope = await dispatchFailure(new Error("database details"));

    expect(payloadOf(envelope)).toEqual({
      type: "work_item_response",
      command: "archive_work_item",
      requestId: "request-1",
      success: false,
      error: "Work-item command failed",
      code: "internal",
      latest: null,
    });
  });

  it("reports an unavailable service without a snapshot", async () => {
    const envelope = await dispatchFailure();

    expect(payloadOf(envelope)).toEqual({
      type: "work_item_response",
      command: "archive_work_item",
      requestId: "request-1",
      success: false,
      error: "Work-item service is unavailable",
      code: "unavailable",
      latest: null,
    });
  });

  it("round-trips every server failure through the client parser", async () => {
    const cases = [
      {
        envelope: await dispatchFailure(
          new WorkItemServiceError("conflict", "stale revision", detail),
        ),
        code: "conflict",
        message: "stale revision",
        latestId: "work-1",
      },
      {
        envelope: await dispatchFailure(new Error("database details")),
        code: "internal",
        message: "Work-item command failed",
        latestId: undefined,
      },
      {
        envelope: await dispatchFailure(),
        code: "unavailable",
        message: "Work-item service is unavailable",
        latestId: undefined,
      },
    ];

    for (const testCase of cases) {
      const parsed = errorFromWorkItemResponse(testCase.envelope);
      expect(parsed).toMatchObject({
        code: testCase.code,
        message: testCase.message,
      });
      expect(parsed?.latest?.workItem.id).toBe(testCase.latestId);
    }
  });
});
