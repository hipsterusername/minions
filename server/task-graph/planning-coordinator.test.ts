import "./test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import type { Bus } from "../bus.ts";
import type { WsEnvelope } from "../../shared/ws-envelope.ts";
import type { SemanticTaskGraphPlan } from "../../shared/task-graph-planning-contracts.ts";
import { initDb } from "../db.ts";
import { ensureWorkItemSchema } from "../work-item-schema.ts";
import { createWorkItem, startWorkItemIteration } from "../work-item-repo.ts";
import { TaskGraphService } from "./service.ts";
import { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";
import type { CapturedPlanningSource, PlanningSourceContext } from "./planning-source.ts";
import { migrateTaskGraph } from "./schema.ts";
import {storeInlineTaskGraphArtifact} from "./artifact-store.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function fakeBus() {
  const listeners = new Set<(envelope: WsEnvelope) => void>();
  const emitted: WsEnvelope[] = [];
  const fan = (envelope: WsEnvelope) => { emitted.push(envelope); listeners.forEach((fn) => fn(envelope)); };
  const bus: Bus = {
    emit: fan,
    emitToSession: (id, payload) => fan({ topic: `session:${id}`, ...payload }),
    emitToProject: (id, payload) => fan({ topic: `project:${id}`, ...payload }),
    emitToWorkItem: (id, payload) => fan({ topic: `work-item:${id}`, ...payload }),
    emitGlobal: (payload) => fan({ topic: "global", ...payload }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { bus, emitted };
}

function semanticPlan(): SemanticTaskGraphPlan {
  return { objective: "Implement planning", acceptanceCriteria: ["done"], nonGoals: [],
    constraints: [], assumptions: [], questions: [], maxActiveAttempts: 2, steps: [{
      key: "build", title: "Build", objective: "Build it", acceptanceCriteria: ["passes"],
      constraints: [], dependsOn: [], contextSelectors: ["design"], inputBindings: {},
      outputSchemas: {}, executorClass: "standard", ownershipRequest: [], budgetRequest: {},
      timeoutMs: 30_000, retryPolicy: { maxAttempts: 2, backoffMs: 0,
        retryableOutcomes: ["failed"], jitterMs: 0 }, verificationRequired: false,
      failurePolicy: "fail_graph", risk: "low", requiresApproval: false,
    }] };
}

function setup() {
  const db = initDb(":memory:"); ensureWorkItemSchema(db);
  createWorkItem(db, { id: "work", projectId: "project", projectPath: process.cwd(),
    title: "Work", changeMode: "live", at: 1 });
  startWorkItemIteration(db, { workItemId: "work", runKey: "primary", idempotencyKey: "primary",
    expectedLifecycleRevision: 0, expectedCurrentRunKey: null, at: 2 });
  const transport = fakeBus();
  const service = new TaskGraphService({ db, bus: transport.bus,
    availableDispatchSlots: () => 0,
    children: { startChildRun: async () => { throw new Error("not dispatched in test"); } } });
  let now = 10;
  let fingerprint = HASH_A;
  const capture = vi.fn(async (input: PlanningSourceContext, at: number):
  Promise<CapturedPlanningSource> => ({
    fingerprint,
    policyAllowsAutoStart: true,
    startBlockedReason: null,
    reviewRequirements: [],
    snapshot: { id: `source-${input.revisionId}`, workItemId: input.workItemId,
      primaryRunKey: input.primaryRunKey, taskGraphRevisionId: input.revisionId,
      repositoryBaseCommit: "abc", dirtyDiffDigest: fingerprint,
      workspaceId: input.workspaceId, worktreeIdentity: input.worktreeIdentity,
      systemModelDigest: HASH_A, workPacketRevisionId: null, connectedContext: [],
      compiledSkills: [], harnessPolicyDigest: HASH_A, toolPolicyDigest: HASH_A, createdAt: at },
    scopedSources: [{ sourceSnapshotId: `source-${input.revisionId}`,
      nodeId: input.nodeIdsByStepKey["build"]!, sourceId: "canvas:design",
      contentHash: HASH_A, classification: "internal", content: "Design context" }],
  }));
  const terminal = vi.fn();
  const attention = vi.fn();
  const coordinator = new TaskGraphPlanningCoordinator({ db, bus: transport.bus,
    taskGraphs: service, now: () => now++, captureSource: capture,
    resolveSourceAuthority: () => ({ workspaceId: "workspace", cwd: process.cwd(),
      projectPath: process.cwd(), worktreeIdentity: "primary", connectedContext: "context",
      skillIds: [], skillValues: {}, harnessName: "codex", allowedTools: [] }),
    onTerminal: terminal, onAttention: attention });
  coordinator.start();
  return { db, service, coordinator, transport, capture, attention, terminal,
    drift: () => { fingerprint = HASH_B; } };
}

describe("TaskGraphPlanningCoordinator", () => {
  it("persists a reviewable proposal, materializes a revision, and starts it on approval", async () => {
    const { db, coordinator, transport } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit-1", baseProposalRevision: null, plan: semanticPlan() });
    expect(ready).toMatchObject({ state: "ready", proposalRevision: 1, revision: 1,
      canStart: true, graphRunId: null, autoStartEligible: true });
    expect(db.prepare("SELECT count(*) count FROM task_graph_revisions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT content FROM task_graph_context_sources").get())
      .toEqual({ content: "Design context" });

    const running = await coordinator.approve({ workItemId: "work", proposalId: ready.proposalId,
      expectedProposalRevision: ready.proposalRevision });
    expect(running).toMatchObject({ state: "running", graphRunId: expect.stringMatching(/^graph-run_/) });
    expect(running.revision).toBeGreaterThan(ready.revision);
    expect(transport.emitted.some((event) => event.type === "task_graph_plan_changed")).toBe(true);
  });

  it("migrates legacy pending review blockers without losing the integration requirement", async () => {
    const { db, coordinator } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "legacy-pending", baseProposalRevision: null,
      plan: semanticPlan() });
    const legacyReason = "Work Packet gate Execution graph runtime is required_pending.";
    db.prepare(`UPDATE task_graph_plan_proposals SET start_blocked_reason=?,error=? WHERE id=?`)
      .run(legacyReason, legacyReason, ready.proposalId);

    migrateTaskGraph(db);

    expect(coordinator.repo.get(ready.proposalId)).toMatchObject({
      canStart: true,
      error: null,
      reviewRequirements: [{
        gateId: "legacy.execution.graph.runtime",
        name: "Execution graph runtime",
      }],
    });
  });

  it("replays identical submissions and rejects request-id reuse with different content", async () => {
    const { coordinator } = setup();
    const input = { workItemId: "work", primaryRunKey: "primary", mode: "plan" as const,
      requestId: "same", baseProposalRevision: null, plan: semanticPlan() };
    const first = await coordinator.submit(input);
    await expect(coordinator.submit(input)).resolves.toEqual(first);
    await expect(coordinator.submit({ ...input,
      plan: { ...input.plan, objective: "Different" } })).rejects.toThrow("request id");
  });

  it("marks a prepared proposal stale when source authority drifts before approval", async () => {
    const { coordinator, drift } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });
    drift();
    await expect(coordinator.approve({ workItemId: "work", proposalId: ready.proposalId,
      expectedProposalRevision: 1 })).rejects.toThrow("stale");
    expect(coordinator.snapshot("work", "primary")).toMatchObject({ state: "stale",
      error: expect.stringContaining("Refresh") });
  });

  it("does not let an in-flight approval overwrite a concurrent rejection", async () => {
    const { coordinator, capture } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });
    const frozen = await capture.mock.results[0]!.value;
    let release: (() => void) | undefined;
    capture.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(frozen);
    }));

    const approval = coordinator.approve({ workItemId: "work", proposalId: ready.proposalId,
      expectedProposalRevision: ready.proposalRevision });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    coordinator.reject({ workItemId: "work", proposalId: ready.proposalId,
      expectedProposalRevision: ready.proposalRevision });
    release!();

    await expect(approval).rejects.toThrow("stale graph-plan projection revision");
    expect(coordinator.snapshot("work", "primary")?.state).toBe("rejected");
  });

  it("does not let an in-flight approval start a superseded proposal", async () => {
    const { coordinator, capture } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "first", baseProposalRevision: null, plan: semanticPlan() });
    const frozen = await capture.mock.results[0]!.value;
    let release: (() => void) | undefined;
    capture.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(frozen);
    }));
    const approval = coordinator.approve({ workItemId: "work", proposalId: ready.proposalId,
      expectedProposalRevision: ready.proposalRevision });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    const successor = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "second", baseProposalRevision: ready.proposalRevision,
      plan: { ...semanticPlan(), objective: "Successor" } });
    release!();

    await expect(approval).rejects.toThrow("stale graph-plan projection revision");
    expect(successor).toMatchObject({ proposalRevision: 2, revision: 2, state: "ready" });
    expect(coordinator.repo.get(ready.proposalId)).toMatchObject({
      state: "superseded", revision: 2,
    });
  });

  it.each(["medium", "high"] as const)("auto-starts an eligible %s-risk plan", async (risk) => {
    const { coordinator } = setup();
    const plan = semanticPlan();
    plan.steps[0] = { ...plan.steps[0]!, risk };
    const result = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "auto", requestId: "submit", baseProposalRevision: null, plan });
    expect(result).toMatchObject({ state: "running", graphRunId: expect.any(String) });
  });

  it("keeps explicitly approved steps ready for manual approval in auto mode", async () => {
    const { coordinator } = setup();
    const plan = semanticPlan();
    plan.steps[0] = { ...plan.steps[0]!, requiresApproval: true };
    const result = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "auto", requestId: "submit", baseProposalRevision: null, plan });
    expect(result).toMatchObject({ state: "ready", autoStartEligible: false, graphRunId: null });
  });

  it("keeps unanswered questions in needs-input without materializing a graph", async () => {
    const { coordinator, db, capture } = setup();
    const plan = semanticPlan(); plan.questions = ["Which API should be changed?"];
    const result = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "auto", requestId: "submit", baseProposalRevision: null, plan });
    expect(result).toMatchObject({ state: "needs_input", canStart: false,
      materializedRevisionId: null });
    expect(capture).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) count FROM task_graph_revisions").get()).toEqual({ count: 0 });
  });

  it("persists validation failures so the Leader can repair a successor revision", async () => {
    const { coordinator, capture } = setup();
    capture.mockRejectedValueOnce(new Error("Context selector did not match"));
    const failed = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "invalid", baseProposalRevision: null, plan: semanticPlan() });

    expect(failed).toMatchObject({ state: "failed", proposalRevision: 1,
      materializedRevisionId: null, canStart: false,
      error: "Context selector did not match" });

    const repaired = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "repair", baseProposalRevision: failed.proposalRevision,
      plan: semanticPlan() });
    expect(repaired).toMatchObject({ state: "ready", proposalRevision: 2,
      revision: failed.revision + 1, error: null });
  });

  it("publishes successor proposals on one monotonic projection sequence", async () => {
    const { coordinator, transport } = setup();
    const first = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "first", baseProposalRevision: null, plan: semanticPlan() });
    const second = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "second", baseProposalRevision: first.proposalRevision,
      plan: { ...semanticPlan(), objective: "Improved plan" } });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(transport.emitted.filter((event) => event.type === "task_graph_plan_changed")
      .map((event) => event["revision"])).toEqual([1, 2]);
  });

  it("rolls back proposal metadata when immutable materialization fails", async () => {
    const { coordinator, service, db } = setup();
    const createRevision = vi.spyOn(service, "createRevision")
      .mockImplementationOnce(() => { throw new Error("materialization failed"); });

    await expect(coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() }))
      .rejects.toThrow("materialization failed");
    expect(db.prepare("SELECT count(*) count FROM task_graph_plan_proposals").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM task_graph_revisions").get())
      .toEqual({ count: 0 });

    createRevision.mockRestore();
    await expect(coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() }))
      .resolves.toMatchObject({ state: "ready", revision: 1 });
  });

  it("replays a start left in the persisted starting state", async () => {
    const { coordinator } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });
    coordinator.repo.transition({ proposalId: ready.proposalId,
      expectedProposalRevision: ready.proposalRevision,
      expectedProjectionRevision: ready.revision, state: "starting",
      graphRunId: "graph-run-recovery" }, 20);

    const recovered = await coordinator.approve({ workItemId: "work",
      proposalId: ready.proposalId, expectedProposalRevision: ready.proposalRevision });

    expect(recovered).toMatchObject({ state: "running", graphRunId: "graph-run-recovery" });
  });

  it("replays a persisted starting proposal during coordinator recovery", async () => {
    const { coordinator } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });
    coordinator.repo.transition({ proposalId: ready.proposalId,
      expectedProposalRevision: ready.proposalRevision,
      expectedProjectionRevision: ready.revision, state: "starting",
      graphRunId: "graph-run-boot-recovery" }, 20);
    coordinator.dispose();

    const restarted = new TaskGraphPlanningCoordinator(coordinator.options);
    restarted.start();

    await vi.waitFor(() => expect(restarted.snapshot("work", "primary"))
      .toMatchObject({ state: "running", graphRunId: "graph-run-boot-recovery" }));
    restarted.dispose();
  });

  it("persists a failed graph start and retries its terminal wake after restart", async () => {
    const { coordinator, service, terminal, db } = setup();
    const ready = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });
    vi.spyOn(service,"startRun").mockRejectedValueOnce(new Error("dispatch setup exploded"));

    await expect(coordinator.approve({ workItemId:"work",proposalId:ready.proposalId,
      expectedProposalRevision:ready.proposalRevision })).rejects.toThrow("dispatch setup exploded");
    expect(coordinator.repo.get(ready.proposalId)).toMatchObject({state:"failed",
      error:"dispatch setup exploded"});
    expect(db.prepare(`SELECT terminal_wake_delivered_at deliveredAt
      FROM task_graph_plan_proposals WHERE id=?`).get(ready.proposalId)).toEqual({deliveredAt:null});
    expect(terminal).toHaveBeenCalledOnce();
    await expect(coordinator.submit({workItemId:"work",primaryRunKey:"primary",mode:"plan",
      requestId:"repair-start",baseProposalRevision:ready.proposalRevision,
      plan:{...semanticPlan(),objective:"Repair failed graph start"}}))
      .resolves.toMatchObject({proposalRevision:2,state:"ready",graphRunId:null});
    coordinator.dispose();

    terminal.mockClear();
    const restarted=new TaskGraphPlanningCoordinator(coordinator.options);
    restarted.start();
    await vi.waitFor(()=>expect(terminal).toHaveBeenCalledOnce());
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({state:"failed",
      proposalId:ready.proposalId}));
    restarted.dispose();
  });

  it("requires explicit cancellation before replacing an active graph", async () => {
    const { coordinator } = setup();
    const running = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "auto", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });

    await expect(coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "plan", requestId: "revise", baseProposalRevision: running.proposalRevision,
      plan: { ...semanticPlan(), objective: "Revise the running work" } }))
      .rejects.toThrow("cancel it before submitting a successor");
  });

  it("preserves a cancelled run and starts a fresh successor in the same WorkItem iteration",async()=>{
    const {coordinator}=setup();
    const first=await coordinator.submit({workItemId:"work",primaryRunKey:"primary",
      mode:"auto",requestId:"first",baseProposalRevision:null,plan:semanticPlan()});
    const runtime=coordinator.inspection("work","primary").runtime!;
    const cancelled=await coordinator.cancel({workItemId:"work",primaryRunKey:"primary",
      runId:first.graphRunId!,expectedRunRevision:runtime.revision,requestId:"cancel-first"});
    expect(cancelled).toMatchObject({proposalId:first.proposalId,state:"cancelled"});

    const successor=await coordinator.submit({workItemId:"work",primaryRunKey:"primary",
      mode:"auto",requestId:"second",baseProposalRevision:first.proposalRevision,
      plan:{...semanticPlan(),objective:"Continue with an improved workflow"}});
    expect(successor).toMatchObject({proposalRevision:2,state:"running",
      graphRunId:expect.not.stringMatching(new RegExp(`^${first.graphRunId}$`))});
    expect(coordinator.repo.get(first.proposalId)).toMatchObject({state:"cancelled",
      graphRunId:first.graphRunId});
    expect(coordinator.inspection("work","primary").history).toEqual([
      expect.objectContaining({proposalId:successor.proposalId,proposalRevision:2,state:"running"}),
      expect.objectContaining({proposalId:first.proposalId,proposalRevision:1,state:"cancelled"}),
    ]);
  });

  it.each(["completed","failed"] as const)("starts a successor after a %s graph",async(status)=>{
    const {coordinator,db}=setup();
    const first=await coordinator.submit({workItemId:"work",primaryRunKey:"primary",
      mode:"auto",requestId:"first",baseProposalRevision:null,plan:semanticPlan()});
    db.prepare("UPDATE task_graph_runs SET status=?,revision=revision+1 WHERE id=?")
      .run(status,first.graphRunId);

    const successor=await coordinator.submit({workItemId:"work",primaryRunKey:"primary",
      mode:"plan",requestId:`after-${status}`,baseProposalRevision:first.proposalRevision,
      plan:{...semanticPlan(),objective:`Follow ${status} graph`}});
    expect(successor).toMatchObject({proposalRevision:2,state:"ready",graphRunId:null});
    expect(coordinator.repo.get(first.proposalId).state).toBe(status);
  });

  it("inspects bounded historical plans by proposal or run",async()=>{
    const {coordinator}=setup();
    const first=await coordinator.submit({workItemId:"work",primaryRunKey:"primary",
      mode:"auto",requestId:"first",baseProposalRevision:null,plan:semanticPlan()});
    const runtime=coordinator.inspection("work","primary").runtime!;
    await coordinator.cancel({workItemId:"work",primaryRunKey:"primary",runId:first.graphRunId!,
      expectedRunRevision:runtime.revision,requestId:"cancel"});
    const second=await coordinator.submit({workItemId:"work",primaryRunKey:"primary",
      mode:"plan",requestId:"second",baseProposalRevision:1,
      plan:{...semanticPlan(),objective:"Second workflow"}});

    expect(coordinator.inspection("work","primary",{proposalId:first.proposalId,historyLimit:1}))
      .toMatchObject({plan:{proposalId:first.proposalId,state:"cancelled"},
        runtime:{graphRunId:first.graphRunId},history:[{proposalId:second.proposalId}]});
    expect(coordinator.inspection("work","primary",{graphRunId:first.graphRunId!}).plan)
      .toMatchObject({proposalId:first.proposalId});
  });

  it("reads committed artifacts from a selected historical graph iteration",async()=>{
    const {coordinator,db}=setup();
    const firstPlan=semanticPlan();
    firstPlan.steps[0]={...firstPlan.steps[0]!,outputSchemas:{result:{type:"object"}}};
    const first=await coordinator.submit({workItemId:"work",primaryRunKey:"primary",
      mode:"auto",requestId:"first",baseProposalRevision:null,plan:firstPlan});
    const graph=coordinator.options.taskGraphs.snapshot(first.graphRunId!);
    const nodeId=graph.revision.nodes[0]!.id;
    const stored=storeInlineTaskGraphArtifact({source:"inline",inlineJson:{value:"historic"},
      outputName:"result",schemaName:"Result",schemaVersion:"1",classification:"internal",
      retentionPolicy:"graph-run",observedWriteSet:[]},{type:"object"});
    db.prepare(`INSERT INTO task_node_attempts
      (id,run_id,node_id,attempt_number,generation,source_snapshot_id,runtime,outcome,
        progress_seq,created_at,updated_at)
      VALUES('historic-attempt',?,?,1,1,?,'terminal','succeeded',0,20,20)`)
      .run(first.graphRunId,nodeId,graph.run.sourceSnapshotId);
    db.prepare(`INSERT INTO task_artifacts
      (id,run_id,node_id,producer_attempt_id,source_snapshot_id,output_name,content_hash,
        metadata_json,state,created_at,committed_at)
      VALUES('historic-artifact',?,?, 'historic-attempt',?,'result',?,?,'committed',20,20)`)
      .run(first.graphRunId,nodeId,graph.run.sourceSnapshotId,stored.contentHash,
        JSON.stringify(stored));
    const runtime=coordinator.inspection("work","primary").runtime!;
    await coordinator.cancel({workItemId:"work",primaryRunKey:"primary",runId:first.graphRunId!,
      expectedRunRevision:runtime.revision,requestId:"cancel"});
    await coordinator.submit({workItemId:"work",primaryRunKey:"primary",mode:"plan",
      requestId:"successor",baseProposalRevision:1,
      plan:{...semanticPlan(),objective:"Use prior result"}});

    expect(coordinator.readArtifact({workItemId:"work",primaryRunKey:"primary",
      graphRunId:first.graphRunId!,artifactId:"historic-artifact",offset:0,maxBytes:1_000}))
      .toMatchObject({artifactId:"historic-artifact",content:'{"value":"historic"}'});
    expect(()=>coordinator.readArtifact({workItemId:"work",primaryRunKey:"primary",
      artifactId:"historic-artifact",offset:0,maxBytes:1_000}))
      .toThrow("no runtime artifacts");
  });

  it("wakes graph attention once per blocked runtime revision", async () => {
    const { coordinator, transport, attention } = setup();
    const running = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "auto", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });
    const blocked = { topic: "work-item:work", type: "task_graph_changed",
      workItemId: "work", runId: running.graphRunId!, revision: 8, timestamp: 30,
      cause: "blocked", changes: { status: "blocked" } } as unknown as WsEnvelope;

    transport.bus.emit(blocked);
    transport.bus.emit(blocked);

    expect(attention).toHaveBeenCalledTimes(1);
    expect(attention).toHaveBeenCalledWith(
      expect.objectContaining({ state: "running" }), "blocked", 8,
    );
  });

  it("reconciles a terminal graph and wakes synthesis after coordinator restart", async () => {
    const { coordinator, db, terminal } = setup();
    const running = await coordinator.submit({ workItemId: "work", primaryRunKey: "primary",
      mode: "auto", requestId: "submit", baseProposalRevision: null, plan: semanticPlan() });
    coordinator.dispose();
    db.prepare("UPDATE task_graph_runs SET status='completed',revision=revision+1 WHERE id=?")
      .run(running.graphRunId);

    const recovered = new TaskGraphPlanningCoordinator(coordinator.options);
    recovered.start();

    await vi.waitFor(() => expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed", graphRunId: running.graphRunId }),
    ));
    expect(recovered.snapshot("work", "primary")?.state).toBe("completed");
    recovered.acknowledgeTerminalWake(running.proposalId, running.graphRunId!);
    expect(db.prepare(`SELECT terminal_wake_delivered_at deliveredAt
      FROM task_graph_plan_proposals WHERE id=?`).get(running.proposalId))
      .toEqual({ deliveredAt: expect.any(Number) });
    recovered.dispose();

    terminal.mockClear();
    const acknowledged = new TaskGraphPlanningCoordinator(coordinator.options);
    acknowledged.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminal).not.toHaveBeenCalled();
    acknowledged.dispose();
  });
});
