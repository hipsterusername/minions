import { z } from "zod/v4";
import { leaderProcedurePointer } from "../../shared/leader-procedures.ts";
import {
  semanticTaskGraphPlanSchema,
  type LeaderOrchestrationMode,
  type TaskGraphPlanSnapshotView,
} from "../../shared/task-graph-planning-contracts.ts";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import type { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";
import {TaskGraphConflictError} from "./errors.ts";
import {
  buildDialecticGraphPlan,
  submitDialecticGraphSchema,
} from "../dialectic/graph-plan.ts";
import {
  initializeGraphDocumentSchema,
  inspectGraphDocumentSchema,
  removeGraphDocumentEdgeSchema,
  removeGraphDocumentNodeSchema,
  SemanticGraphDocumentDraft,
  submitGraphDocumentSchema,
  upsertGraphDocumentEdgeSchema,
  upsertGraphDocumentNodeSchema,
} from "./graph-document.ts";

const submitSchema = z.object({
  requestId: z.string().min(1).describe("Stable idempotency key for this semantic plan submission."),
  baseProposalRevision: z.number().int().positive().nullable().default(null)
    .describe("The current proposal revision being revised or followed by a new serial iteration; null only when no proposal exists."),
  plan: semanticTaskGraphPlanSchema,
});
const startSchema = z.object({
  proposalId: z.string().min(1),
  expectedProposalRevision: z.number().int().positive(),
});
const getSchema=z.object({
  proposalId:z.string().min(1).optional(),
  graphRunId:z.string().min(1).optional(),
  historyLimit:z.number().int().min(1).max(50).default(20),
}).superRefine((value,ctx)=>{
  if (value.proposalId && value.graphRunId) ctx.addIssue({code:"custom",
    message:"proposalId and graphRunId are mutually exclusive"});
});
const readArtifactSchema = z.object({
  artifactId: z.string().min(1),
  graphRunId:z.string().min(1).optional()
    .describe("Select a historical graph iteration; defaults to the latest plan's run."),
  offset: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().min(1).max(262_144).default(65_536),
});
const cancelSchema=z.object({
  requestId:z.string().min(1).describe("Stable idempotency key for this cancellation."),
  runId:z.string().min(1),
  expectedRunRevision:z.number().int().nonnegative(),
});
const adjudicateSchema=z.object({
  requestId:z.string().min(1).describe("Stable idempotency key for this adjudication."),
  runId:z.string().min(1),nodeId:z.string().min(1),currentAttemptId:z.string().min(1),
  expectedRunRevision:z.number().int().nonnegative(),
  decision:z.enum(["accepted","rejected","retry"]),
  reason:z.string().trim().min(1).max(2_000),
  guidance:z.string().trim().min(1).max(4_000).optional(),
}).superRefine((value,ctx)=>{
  if (value.guidance && value.decision!=="retry") {
    ctx.addIssue({code:"custom",path:["guidance"],message:"guidance is only valid for retry"});
  }
});
const moderateDialecticSchema=z.object({
  requestId:z.string().min(1).describe("Stable idempotency key for this moderation decision."),
  runId:z.string().min(1),checkpointNodeId:z.string().min(1),
  expectedRunRevision:z.number().int().nonnegative(),
  decision:z.enum(["continue","reshape","stop"]),
  instructions:z.string().trim().min(1).max(4_000).optional(),
}).superRefine((value,ctx)=>{
  if (value.decision==="reshape"&&!value.instructions) ctx.addIssue({code:"custom",
    path:["instructions"],message:"reshape requires moderation instructions"});
});

export function createTaskGraphPlanningTools(input: {
  coordinator: TaskGraphPlanningCoordinator;
  workItemId: string;
  primaryRunKey: string;
  mode: Exclude<LeaderOrchestrationMode, "direct">;
  leaderSessionKey: string;
  markDecisionNeeded?: (reason: string) => void;
}): NormalizedToolDef[] {
  const document = new SemanticGraphDocumentDraft();
  const handleProjection = (snapshot: TaskGraphPlanSnapshotView) => {
    if (snapshot.state === "needs_input") {
      input.markDecisionNeeded?.(snapshot.questions[0] ?? "The execution plan needs input.");
    } else if (snapshot.state === "ready" && snapshot.canStart
      && (input.mode === "plan" || !snapshot.autoStartEligible)) {
      input.markDecisionNeeded?.("The execution plan is ready for review and approval.");
    }
    return { ...snapshot, procedure: leaderProcedurePointer(
      snapshot.state === "ready" || snapshot.state === "needs_input" ? "review_start"
        : snapshot.state === "running" ? "graph_authoring" : "adjudication") };
  };
  return [
    {
      name: "initialize_graph_document",
      description: "Initialize or replace the session-local semantic graph draft at the exact document revision. The optional pattern and problemSignature fields record reviewed authoring provenance; iteration metadata bounds successor episodes. The server applies all omitted plan defaults and starts with no nodes or edges.",
      inputSchema: initializeGraphDocumentSchema,
      handler: async (raw) => {
        const args = initializeGraphDocumentSchema.parse(raw);
        return jsonResult(document.initialize(args.plan, args.expectedDocumentRevision));
      },
    },
    {
      name: "upsert_graph_node",
      description: "Add or deterministically replace one semantic graph node at the exact document revision. Before adding artifact edges, declare their named outputs in the producer's outputSchemas and named inputs in the consumer's inputBindings. Omitted node fields receive server-owned defaults.",
      inputSchema: upsertGraphDocumentNodeSchema,
      handler: async (raw) => {
        const args = upsertGraphDocumentNodeSchema.parse(raw);
        return jsonResult(document.upsertNode(args.node, args.expectedDocumentRevision));
      },
    },
    {
      name: "remove_graph_node",
      description: "Remove one semantic graph node at the exact document revision. Incident edges and terminal references must be removed explicitly first.",
      inputSchema: removeGraphDocumentNodeSchema,
      handler: async (raw) => {
        const args = removeGraphDocumentNodeSchema.parse(raw);
        return jsonResult(document.removeNode(args.stepKey, args.expectedDocumentRevision));
      },
    },
    {
      name: "upsert_graph_edge",
      description: "Add or deterministically replace one semantic dependency at the exact document revision. Use a control edge with null bindings for ordering only. For an artifact edge, sourceOutput must already exist in the source node's outputSchemas and targetInput in the target node's inputBindings. Dependency identity includes both endpoints, kind, and artifact bindings, so multiple mapped outputs may connect the same nodes.",
      inputSchema: upsertGraphDocumentEdgeSchema,
      handler: async (raw) => {
        const args = upsertGraphDocumentEdgeSchema.parse(raw);
        return jsonResult(document.upsertEdge(args.edge, args.expectedDocumentRevision));
      },
    },
    {
      name: "remove_graph_edge",
      description: "Remove the dependency identified by its endpoints, kind, and artifact bindings at the exact document revision.",
      inputSchema: removeGraphDocumentEdgeSchema,
      handler: async (raw) => {
        const args = removeGraphDocumentEdgeSchema.parse(raw);
        return jsonResult(document.removeEdge(args,args.expectedDocumentRevision));
      },
    },
    {
      name: "get_graph_document",
      description: "Inspect the session-local semantic graph draft. Compact view returns topology and context selectors; full view returns the assembled semantic plan.",
      inputSchema: inspectGraphDocumentSchema,
      annotations: { readOnlyHint: true },
      handler: async (raw) => {
        const args = inspectGraphDocumentSchema.parse(raw);
        return jsonResult(document.inspect(args.view));
      },
    },
    {
      name: "submit_graph_document",
      description: "Validate and submit the exact semantic graph document revision through the existing planning coordinator. Canonical compilation, source freezing, review, and auto-start policy remain server-owned.",
      inputSchema: submitGraphDocumentSchema,
      handler: async (raw) => {
        const args = submitGraphDocumentSchema.parse(raw);
        const plan = semanticTaskGraphPlanSchema.parse(
          document.submissionPlan(args.expectedDocumentRevision),
        );
        const snapshot = handleProjection(await input.coordinator.submit({
          workItemId: input.workItemId,
          primaryRunKey: input.primaryRunKey,
          mode: input.mode,
          requestId: args.requestId,
          baseProposalRevision: args.baseProposalRevision,
          plan,
        }));
        return jsonResult({ documentRevision: args.expectedDocumentRevision, snapshot });
      },
    },
    {
      name: "submit_graph_plan",
      description: "Submit or revise a semantic execution plan. Optionally declare a reviewed pattern and problemSignature; the server shows a deterministic recommendation and lint findings without giving the pattern runtime authority. Use control dependencies for ordering only; every artifact dependency must map a sourceOutput declared by its producer's outputSchemas to a targetInput declared by its consumer's inputBindings. For partial synthesis, use quorum artifact dependencies, or pair required skipped/all-terminal control dependencies with optional artifact dependencies; use fail_graph only for truly fail-fast nodes. Draft proposal revisions remain replaceable until start. After a run is terminal or explicitly cancelled, submit a successor with the latest baseProposalRevision and bounded iteration metadata; an active run must be cancelled first. Executed revisions and evidence remain immutable.",
      inputSchema: submitSchema,
      handler: async (raw) => {
        const args = submitSchema.parse(raw);
        return jsonResult(handleProjection(await input.coordinator.submit({
          workItemId: input.workItemId,
          primaryRunKey: input.primaryRunKey,
          mode: input.mode,
          ...args,
        })));
      },
    },
    {
      name:"submit_dialectic_graph",
      description:"Build and submit a bounded p13.dialectic execution graph. The server creates two role-differentiated participant chains plus periodic synthesis checkpoints, stable provider-thread affinities, structured goal-distance artifacts, and Leader gates. Executor tiers differ by default; exact harness/model overrides are optional. Use this as a primary reasoning tool for genuinely difficult or ambiguous problems, not routine work.",
      inputSchema:submitDialecticGraphSchema,
      handler:async(raw)=>{
        const args=submitDialecticGraphSchema.parse(raw);
        const plan=buildDialecticGraphPlan(args);
        return jsonResult(handleProjection(await input.coordinator.submit({
          workItemId:input.workItemId,primaryRunKey:input.primaryRunKey,mode:input.mode,
          requestId:args.requestId,baseProposalRevision:args.baseProposalRevision,plan,
        })));
      },
    },
    {
      name: "get_graph_plan",
      description: "Read current or historical plans, runtime and bounded history across Leader continuations in this WorkItem. Select by proposalId or graphRunId. Earlier Leader runs are read-only; mutations retain current-run authority.",
      inputSchema: getSchema,
      handler: async (raw) => {
        const args=getSchema.parse(raw);
        const inspection=input.coordinator.inspection(input.workItemId,input.primaryRunKey,args);
        return jsonResult({ ...inspection,
          historicalReadOnly: Boolean(inspection.plan && inspection.plan.primaryRunKey !== input.primaryRunKey),
          procedure: leaderProcedurePointer(inspection.plan?.state === "ready" || inspection.plan?.state === "needs_input"
            ? "review_start" : "adjudication"),
        });
      },
    },
    {
      name: "start_graph_plan",
      description: "Start the exact prepared proposal revision after the user approves it conversationally. Source or authority drift returns a stale-plan conflict instead of silently changing the run.",
      inputSchema: startSchema,
      handler: async (raw) => {
        const args = startSchema.parse(raw);
        return jsonResult(handleProjection(await input.coordinator.approve({
          workItemId: input.workItemId,
          ...args,
        })));
      },
    },
    {
      name: "read_graph_artifact",
      description: "Read a bounded committed artifact from a current or historical graph in this WorkItem, including earlier Leader continuations. The caller must be the current Leader. Reads remain run- and attempt-scoped, reject stale or secret artifacts, and never expose server storage paths.",
      inputSchema: readArtifactSchema,
      handler: async (raw) => {
        const args = readArtifactSchema.parse(raw);
        return jsonResult(input.coordinator.readArtifact({
          workItemId: input.workItemId,
          primaryRunKey: input.primaryRunKey,
          ...args,
        }));
      },
    },
    {
      name:"cancel_graph_run",
      description:"Explicitly cancel the current active graph with an exact run-revision fence so a successor plan can be submitted. Cancellation preserves the immutable run, evidence, and history and never creates the successor implicitly.",
      inputSchema:cancelSchema,
      handler:async(raw)=>{
        const args=cancelSchema.parse(raw);
        return jsonResult(await input.coordinator.cancel({workItemId:input.workItemId,
          primaryRunKey:input.primaryRunKey,...args}));
      },
    },
    {
      name:"moderate_dialectic",
      description:"Resolve a non-final dialectic synthesis gate with an exact run-revision fence. Continue supplies the next episode with Leader guidance; reshape also revision-fences steering across the remaining dialectic subtree; stop cancels further turns while preserving checkpoint evidence.",
      inputSchema:moderateDialecticSchema,
      handler:async(raw)=>{
        const args=moderateDialecticSchema.parse(raw);
        const service=input.coordinator.options.taskGraphs;
        let graph=service.snapshot(args.runId);
        if (graph.run.workItemId!==input.workItemId
          ||graph.run.primaryRunKey!==input.primaryRunKey) {
          throw new TaskGraphConflictError("graph is outside the current Leader authority",graph);
        }
        if (graph.run.revision!==args.expectedRunRevision) {
          throw new TaskGraphConflictError("stale graph-run revision",graph);
        }
        const checkpoint=graph.revision.nodes.find(node=>node.id===args.checkpointNodeId);
        if (checkpoint?.reasoning?.kind!=="dialectic"
          ||checkpoint.reasoning.phase!=="synthesis"||checkpoint.reasoning.final) {
          throw new TaskGraphConflictError("node is not a non-final dialectic checkpoint",graph);
        }
        if (args.decision==="stop") {
          await service.cancel(args.runId,args.expectedRunRevision,`${args.requestId}:cancel`);
          return jsonResult(service.viewSnapshot(args.runId));
        }
        const gates=graph.revision.edges.filter(edge=>edge.sourceNodeId===checkpoint.id
          &&edge.kind==="human_gate");
        if (gates.length!==1) throw new TaskGraphConflictError(
          "dialectic checkpoint does not have exactly one Leader gate",graph);
        const targetNodeId=gates[0]!.targetNodeId;
        if (args.decision==="reshape") {
          graph=await service.steer({runId:args.runId,
            expectedRunRevision:args.expectedRunRevision,requestId:`${args.requestId}:steer`,
            instructions:args.instructions!,affectedNodeIds:[targetNodeId]});
        }
        const guidance=[`Leader decision: ${args.decision}.`,args.instructions??
          "Continue the dialectic using the checkpoint's highest-priority unresolved questions."].join("\n");
        await service.provideInput({runId:args.runId,nodeId:targetNodeId,
          expectedRunRevision:graph.run.revision,actor:`leader:${input.leaderSessionKey}`,
          value:guidance,requestId:`${args.requestId}:input`});
        return jsonResult(service.viewSnapshot(args.runId));
      },
    },
    {
      name:"adjudicate_graph_node",
      description:"Resolve the current unsuccessful verification-mode node. Accept only with an evidence-backed reason, reject to record terminal failure, or retry with bounded guidance. The server derives the Leader actor and fences the current WorkItem, primary run, graph revision, and attempt.",
      inputSchema:adjudicateSchema,
      handler:async(raw)=>{
        const args=adjudicateSchema.parse(raw);
        const service=input.coordinator.options.taskGraphs;
        const graph=service.snapshot(args.runId);
        if (graph.run.workItemId!==input.workItemId
          || graph.run.primaryRunKey!==input.primaryRunKey) {
          throw new TaskGraphConflictError("graph is outside the current Leader authority",graph);
        }
        await service.adjudicateNode({...args,actor:`leader:${input.leaderSessionKey}`});
        return jsonResult(service.viewSnapshot(args.runId));
      },
    },
  ];
}
