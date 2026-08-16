import "./test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import type { Bus, BusPayload } from "../bus.ts";
import type { WsEnvelope } from "../../shared/ws-envelope.ts";
import type { SemanticTaskGraphPlan, TaskGraphPlanSnapshotView } from
  "../../shared/task-graph-planning-contracts.ts";
import type { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";
import { createTaskGraphPlanningTools } from "./planning-tools.ts";

function plan(): SemanticTaskGraphPlan {
  return {
    objective: "Build the feature",
    acceptanceCriteria: ["It works"],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    questions: [],
    maxActiveAttempts: 1,
    steps: [{
      key: "build",
      title: "Build",
      objective: "Build the feature",
      acceptanceCriteria: ["Tests pass"],
      constraints: [],
      dependsOn: [],
      contextSelectors: [],
      inputBindings: {},
      outputSchemas: {},
      executorClass: "standard",
      ownershipRequest: [],
      budgetRequest: {},
      timeoutMs: 30_000,
      retryPolicy: {
        maxAttempts: 1,
        backoffMs: 0,
        retryableOutcomes: ["failed"],
        jitterMs: 0,
      },
      verificationRequired: false,
      failurePolicy: "fail_graph",
      risk: "low",
      requiresApproval: false,
    }],
  };
}

function snapshot(state: TaskGraphPlanSnapshotView["state"]): TaskGraphPlanSnapshotView {
  return {
    proposalId: "proposal",
    workItemId: "work",
    primaryRunKey: "primary",
    revision: 2,
    proposalRevision: 1,
    baseProposalRevision: null,
    state,
    mode: "auto",
    objective: "Build the feature",
    acceptanceCriteria: ["It works"],
    assumptions: [],
    questions: [],
    workPacketId: null,
    steps: [],
    materializedRevisionId: "revision",
    graphRunId: state === "running" ? "run" : null,
    sourceSnapshotId: "source",
    autoStartEligible: true,
    canStart: state === "ready",
    reviewRequirements: [],
    error: null,
    updatedAt: 1,
  };
}

describe("graph planning tools", () => {
  it("records and persists a durable wait when a submitted graph is running", async () => {
    const emitted: WsEnvelope[] = [];
    const bus: Bus = {
      emit: (envelope) => { emitted.push(envelope); },
      emitToSession: (sessionKey: string, payload: BusPayload) => {
        emitted.push({ topic: `session:${sessionKey}`, ...payload } as WsEnvelope);
      },
      emitToProject: () => {},
      emitGlobal: () => {},
      subscribe: () => () => {},
    };
    const coordinator = {
      submit: vi.fn(async () => snapshot("running")),
    } as unknown as TaskGraphPlanningCoordinator;
    const timerId = {} as ReturnType<typeof setTimeout>;
    const scheduleWaitContinue = vi.fn(() => timerId);
    const taskState = { tasks: new Map(), pendingWait: null, approval: null };
    const onTaskStateChange = vi.fn();
    const tools = createTaskGraphPlanningTools({
      coordinator,
      workItemId: "work",
      primaryRunKey: "primary",
      mode: "auto",
      leaderSessionKey: "leader",
      bus,
      taskState,
      onTaskStateChange,
      scheduleWaitContinue,
    });

    await tools.find((tool) => tool.name === "submit_graph_plan")!.handler({
      requestId: "request",
      baseProposalRevision: null,
      plan: plan(),
    });

    expect(scheduleWaitContinue).toHaveBeenCalledWith(
      1_800_000,
      "Waiting for the execution graph to finish",
    );
    expect(taskState.pendingWait).toMatchObject({
      durationMs: 1_800_000,
      timerId,
      taskIds: [],
    });
    expect(onTaskStateChange).toHaveBeenCalledWith(taskState);
    expect(emitted).toContainEqual(expect.objectContaining({
      topic: "session:leader",
      type: "wait_state",
      action: "started",
    }));
  });

  it("inspects a running graph without interrupting the leader again", async () => {
    const coordinator = {
      inspection: vi.fn(() => ({ plan: snapshot("running"), runtime: null })),
    } as unknown as TaskGraphPlanningCoordinator;
    const scheduleWaitContinue = vi.fn(() => null);
    const taskState = { tasks: new Map(), pendingWait: null, approval: null };
    const tools = createTaskGraphPlanningTools({
      coordinator,
      workItemId: "work",
      primaryRunKey: "primary",
      mode: "auto",
      leaderSessionKey: "leader",
      bus: {
        emit: () => {}, emitToSession: () => {}, emitToProject: () => {},
        emitGlobal: () => {}, subscribe: () => () => {},
      },
      taskState,
      scheduleWaitContinue,
    });

    await tools.find((tool) => tool.name === "get_graph_plan")!.handler({});

    expect(scheduleWaitContinue).not.toHaveBeenCalled();
    expect(taskState.pendingWait).toBeNull();
  });

  it("binds artifact reads to the canonical WorkItem and primary run", async () => {
    const readArtifact = vi.fn(() => ({ artifactId: "artifact", content: "result" }));
    const coordinator = { readArtifact } as unknown as TaskGraphPlanningCoordinator;
    const tools = createTaskGraphPlanningTools({
      coordinator,
      workItemId: "work",
      primaryRunKey: "primary",
      mode: "plan",
      leaderSessionKey: "leader",
      bus: {
        emit: () => {}, emitToSession: () => {}, emitToProject: () => {},
        emitGlobal: () => {}, subscribe: () => () => {},
      },
      taskState: { tasks: new Map(), pendingWait: null, approval: null },
    });

    await tools.find((tool) => tool.name === "read_graph_artifact")!.handler({
      artifactId: "artifact",
    });

    expect(readArtifact).toHaveBeenCalledWith({
      workItemId: "work",
      primaryRunKey: "primary",
      artifactId: "artifact",
      offset: 0,
      maxBytes: 65_536,
    });
  });
});
