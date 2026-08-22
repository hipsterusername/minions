import { z } from "zod/v4";
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
    return snapshot;
  };
  return [
    {
      name: "initialize_graph_document",
      description: "Initialize or replace the session-local semantic graph draft at the exact document revision. The server applies all omitted plan defaults and starts with no nodes or edges.",
      inputSchema: initializeGraphDocumentSchema,
      handler: async (raw) => {
        const args = initializeGraphDocumentSchema.parse(raw);
        return jsonResult(document.initialize(args.plan, args.expectedDocumentRevision));
      },
    },
    {
      name: "upsert_graph_node",
      description: "Add or deterministically replace one semantic graph node at the exact document revision. Omitted node fields receive server-owned defaults.",
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
      description: "Add or deterministically replace one semantic dependency at the exact document revision. Dependency identity includes both endpoints, kind, and artifact bindings, so multiple mapped outputs may connect the same nodes.",
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
      description: "Submit or revise a semantic execution plan. Draft proposal revisions remain replaceable until start. After a run is terminal or explicitly cancelled, submit a successor with the latest baseProposalRevision to start a fresh serial graph iteration; an active run must be cancelled first. Executed revisions and evidence remain immutable.",
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
      name: "get_graph_plan",
      description: "Read the latest or selected persisted graph plan, its canonical runtime projection, and bounded serial iteration history. Select history by proposalId or graphRunId.",
      inputSchema: getSchema,
      handler: async (raw) => {
        const args=getSchema.parse(raw);
        const inspection=input.coordinator.inspection(input.workItemId,input.primaryRunKey,args);
        return jsonResult(inspection);
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
      description: "Read a bounded chunk of a committed artifact from the latest or selected historical graph run. Reads remain WorkItem-, primary-authority-, run-, and attempt-scoped, reject stale or secret artifacts, and never expose server storage paths.",
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
