import "./test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import type { SemanticTaskGraphPlan, TaskGraphPlanSnapshotView } from
  "../../shared/task-graph-planning-contracts.ts";
import type { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";
import { createTaskGraphPlanningTools } from "./planning-tools.ts";
import {TaskGraphConflictError} from "./errors.ts";

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

function snapshot(state: TaskGraphPlanSnapshotView["state"],
  overrides: Partial<TaskGraphPlanSnapshotView> = {}): TaskGraphPlanSnapshotView {
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
    topologyWarnings: [],
    error: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe("graph planning tools", () => {
  it("returns a running graph without forcing the Leader into a wait", async () => {
    const coordinator = {
      submit: vi.fn(async () => snapshot("running")),
    } as unknown as TaskGraphPlanningCoordinator;
    const markDecisionNeeded = vi.fn();
    const tools = createTaskGraphPlanningTools({
      coordinator,
      workItemId: "work",
      primaryRunKey: "primary",
      mode: "auto",
      leaderSessionKey: "leader",
      markDecisionNeeded,
    });

    const result = await tools.find((tool) => tool.name === "submit_graph_plan")!.handler({
      requestId: "request",
      baseProposalRevision: null,
      plan: plan(),
    });

    expect(result).toEqual(expect.objectContaining({ content: expect.any(Array) }));
    expect(markDecisionNeeded).not.toHaveBeenCalled();
  });

  it("submits the specialized dialectic topology through the canonical coordinator",async()=>{
    const submit=vi.fn(async(_request:unknown)=>snapshot("running"));
    const coordinator={submit} as unknown as TaskGraphPlanningCoordinator;
    const tools=createTaskGraphPlanningTools({coordinator,workItemId:"work",
      primaryRunKey:"primary",mode:"auto",leaderSessionKey:"leader"});

    await tools.find(tool=>tool.name==="submit_dialectic_graph")!.handler({
      requestId:"dialectic",baseProposalRevision:null,objective:"Resolve the tradeoff",
      acceptanceCriteria:["A defensible choice is produced"],mode:"proposer-critic",
      rounds:3,checkpointEvery:1,participantA:{},participantB:{},synthesizer:{},
      contextSelectors:[],
    });

    const submitted=submit.mock.calls[0]![0] as {plan:SemanticTaskGraphPlan};
    expect(submitted.plan.pattern).toEqual({id:"p13.dialectic",version:1});
    expect(submitted.plan.steps.some((step:SemanticTaskGraphPlan["steps"][number])=>
      step.dependsOn.some(edge=>edge.kind==="human_gate"))).toBe(true);
    expect(submitted.plan.steps.filter((step:SemanticTaskGraphPlan["steps"][number])=>
      step.reasoning?.participantId==="A").map((step:SemanticTaskGraphPlan["steps"][number])=>
        step.sessionAffinity?.sequence)).toEqual([0,1,2]);
  });

  it("inspects a running graph without interrupting the Leader", async () => {
    const coordinator = {
      inspection: vi.fn(() => ({ plan: snapshot("running"), runtime: null })),
    } as unknown as TaskGraphPlanningCoordinator;
    const tools = createTaskGraphPlanningTools({
      coordinator,
      workItemId: "work",
      primaryRunKey: "primary",
      mode: "auto",
      leaderSessionKey: "leader",
    });

    await tools.find((tool) => tool.name === "get_graph_plan")!.handler({
      graphRunId:"historic-run",historyLimit:5,
    });

    expect(coordinator.inspection).toHaveBeenCalledWith("work","primary",{
      graphRunId:"historic-run",historyLimit:5,
    });
  });

  it("does not request user approval for pending merge-review metadata", async () => {
    const coordinator = { submit: vi.fn(async () => snapshot("ready", {
      autoStartEligible: true,
      canStart: true,
      reviewRequirements: [{ gateId: "gate.execution", name: "Execution review",
        reason: "Matched packet scope" }],
    })) } as unknown as TaskGraphPlanningCoordinator;
    const markDecisionNeeded = vi.fn();
    const tools = createTaskGraphPlanningTools({
      coordinator,
      workItemId: "work",
      primaryRunKey: "primary",
      mode: "auto",
      leaderSessionKey: "leader",
      markDecisionNeeded,
    });

    await tools.find((tool) => tool.name === "submit_graph_plan")!.handler({
      requestId: "request",
      baseProposalRevision: null,
      plan: plan(),
    });

    expect(markDecisionNeeded).not.toHaveBeenCalled();
  });

  it("still requests user approval for an explicit approval step", async () => {
    const coordinator = { submit: vi.fn(async () => snapshot("ready", {
      autoStartEligible: false,
      canStart: true,
    })) } as unknown as TaskGraphPlanningCoordinator;
    const markDecisionNeeded = vi.fn();
    const tools = createTaskGraphPlanningTools({
      coordinator,
      workItemId: "work",
      primaryRunKey: "primary",
      mode: "auto",
      leaderSessionKey: "leader",
      markDecisionNeeded,
    });

    await tools.find((tool) => tool.name === "submit_graph_plan")!.handler({
      requestId: "request",
      baseProposalRevision: null,
      plan: plan(),
    });

    expect(markDecisionNeeded).toHaveBeenCalledWith(
      "The execution plan is ready for review and approval.",
    );
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
    });

    await tools.find((tool) => tool.name === "read_graph_artifact")!.handler({
      artifactId: "artifact",
      graphRunId:"historic-run",
    });

    expect(readArtifact).toHaveBeenCalledWith({
      workItemId: "work",
      primaryRunKey: "primary",
      artifactId: "artifact",
      graphRunId:"historic-run",
      offset: 0,
      maxBytes: 65_536,
    });
  });

  it("cancels a graph through the fenced planning coordinator control",async()=>{
    const cancel=vi.fn(async()=>snapshot("cancelled",{graphRunId:"run"}));
    const coordinator={cancel} as unknown as TaskGraphPlanningCoordinator;
    const tools=createTaskGraphPlanningTools({coordinator,workItemId:"work",
      primaryRunKey:"primary",mode:"auto",leaderSessionKey:"leader"});

    await tools.find(tool=>tool.name==="cancel_graph_run")!.handler({requestId:"cancel-1",
      runId:"run",expectedRunRevision:9});

    expect(cancel).toHaveBeenCalledWith({workItemId:"work",primaryRunKey:"primary",
      requestId:"cancel-1",runId:"run",expectedRunRevision:9});
  });

  it("lets the Leader adjudicate only its current graph and derives the actor",async()=>{
    const taskGraphs={snapshot:vi.fn(()=>({run:{workItemId:"work",primaryRunKey:"primary"}})),
      adjudicateNode:vi.fn(async()=>({})),viewSnapshot:vi.fn(()=>({graphRunId:"run",revision:8}))};
    const coordinator={options:{taskGraphs}} as unknown as TaskGraphPlanningCoordinator;
    const tools=createTaskGraphPlanningTools({coordinator,workItemId:"work",
      primaryRunKey:"primary",mode:"auto",leaderSessionKey:"leader-run"});
    const adjudicate=tools.find(tool=>tool.name==="adjudicate_graph_node")!;

    await adjudicate.handler({requestId:"decision-1",runId:"run",nodeId:"verify",
      currentAttemptId:"attempt",expectedRunRevision:7,decision:"accepted",
      reason:"I independently confirmed the acceptance criteria."});
    expect(taskGraphs.adjudicateNode).toHaveBeenCalledWith({requestId:"decision-1",
      runId:"run",nodeId:"verify",currentAttemptId:"attempt",expectedRunRevision:7,
      decision:"accepted",reason:"I independently confirmed the acceptance criteria.",
      actor:"leader:leader-run"});

    taskGraphs.snapshot.mockReturnValueOnce({run:{workItemId:"other",primaryRunKey:"primary"}});
    await expect(adjudicate.handler({requestId:"decision-2",runId:"run",nodeId:"verify",
      currentAttemptId:"attempt",expectedRunRevision:8,decision:"rejected",reason:"not valid"}))
      .rejects.toBeInstanceOf(TaskGraphConflictError);
  });

  it("continues, reshapes, or stops only at an authorized dialectic checkpoint",async()=>{
    const checkpoint={id:"synthesis",reasoning:{kind:"dialectic",dialecticId:"d",
      phase:"synthesis",participantId:"synthesis",role:"neutral",round:2,final:false}};
    const graph={run:{workItemId:"work",primaryRunKey:"primary",revision:7},
      revision:{nodes:[checkpoint],edges:[{sourceNodeId:"synthesis",targetNodeId:"next",
        kind:"human_gate"}]}};
    const taskGraphs={snapshot:vi.fn(()=>graph),viewSnapshot:vi.fn(()=>({graphRunId:"run"})),
      provideInput:vi.fn(async()=>graph),steer:vi.fn(async()=>({...graph,run:{...graph.run,
        revision:8}})),cancel:vi.fn(async()=>graph)};
    const coordinator={options:{taskGraphs}} as unknown as TaskGraphPlanningCoordinator;
    const moderate=createTaskGraphPlanningTools({coordinator,workItemId:"work",
      primaryRunKey:"primary",mode:"auto",leaderSessionKey:"leader"})
      .find(tool=>tool.name==="moderate_dialectic")!;

    await moderate.handler({requestId:"continue",runId:"run",checkpointNodeId:"synthesis",
      expectedRunRevision:7,decision:"continue"});
    expect(taskGraphs.provideInput).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId:"next",expectedRunRevision:7,actor:"leader:leader",
      value:expect.stringContaining("Leader decision: continue")}),
    );

    await moderate.handler({requestId:"reshape",runId:"run",checkpointNodeId:"synthesis",
      expectedRunRevision:7,decision:"reshape",instructions:"Challenge the cost premise."});
    expect(taskGraphs.steer).toHaveBeenCalledWith(expect.objectContaining({
      expectedRunRevision:7,affectedNodeIds:["next"],instructions:"Challenge the cost premise."}));
    expect(taskGraphs.provideInput).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedRunRevision:8,value:expect.stringContaining("Challenge the cost premise.")}));

    await moderate.handler({requestId:"stop",runId:"run",checkpointNodeId:"synthesis",
      expectedRunRevision:7,decision:"stop"});
    expect(taskGraphs.cancel).toHaveBeenCalledWith("run",7,"stop:cancel");
  });
});
