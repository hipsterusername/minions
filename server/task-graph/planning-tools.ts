import { z } from "zod/v4";
import {
  semanticTaskGraphPlanSchema,
  type LeaderOrchestrationMode,
  type TaskGraphPlanSnapshotView,
} from "../../shared/task-graph-planning-contracts.ts";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import type { Bus } from "../bus.ts";
import type { TaskManagerState } from "../task-tools/types.ts";
import type { TaskGraphPlanningCoordinator } from "./planning-coordinator.ts";

const submitSchema = z.object({
  requestId: z.string().min(1).describe("Stable idempotency key for this semantic plan submission."),
  baseProposalRevision: z.number().int().positive().nullable().default(null)
    .describe("The proposal revision being revised; null only for the first proposal."),
  plan: semanticTaskGraphPlanSchema,
});
const startSchema = z.object({
  proposalId: z.string().min(1),
  expectedProposalRevision: z.number().int().positive(),
});
const getSchema = z.object({});
const readArtifactSchema = z.object({
  artifactId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().min(1).max(262_144).default(65_536),
});

export function createTaskGraphPlanningTools(input: {
  coordinator: TaskGraphPlanningCoordinator;
  workItemId: string;
  primaryRunKey: string;
  mode: Exclude<LeaderOrchestrationMode, "direct">;
  leaderSessionKey: string;
  bus: Bus;
  taskState: TaskManagerState;
  onTaskStateChange?: (state: TaskManagerState) => void;
  markDecisionNeeded?: (reason: string) => void;
  scheduleWaitContinue?: (
    durationMs: number,
    reason: string,
  ) => ReturnType<typeof setTimeout> | null | void;
}): NormalizedToolDef[] {
  const handleProjection = (snapshot: TaskGraphPlanSnapshotView) => {
    if (snapshot.state === "needs_input") {
      input.markDecisionNeeded?.(snapshot.questions[0] ?? "The execution plan needs input.");
    } else if (snapshot.state === "ready") {
      input.markDecisionNeeded?.("The execution plan is ready for review and approval.");
    } else if (snapshot.state === "running") {
      const durationMs = 1_800_000;
      const reason = "Waiting for the execution graph to finish";
      const scheduledAt = Date.now();
      const timerId = input.scheduleWaitContinue?.(durationMs, reason);
      input.taskState.pendingWait = {
        durationMs,
        reason,
        scheduledAt,
        timerId: timerId ?? null,
        taskIds: [],
      };
      input.bus.emitToSession(input.leaderSessionKey, {
        type: "wait_state",
        sessionKey: input.leaderSessionKey,
        action: "started",
        durationMs,
        reason,
        scheduledAt,
      });
      input.onTaskStateChange?.(input.taskState);
    }
    return snapshot;
  };
  return [
    {
      name: "submit_graph_plan",
      description: "Submit or revise a semantic execution plan. The server generates canonical graph identity, validates topology and policy, freezes task-scoped context, and either prepares the plan for review or auto-starts an eligible plan. Do not include private reasoning; submit outcomes, dependencies, context selectors, evidence, risks, and acceptance criteria.",
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
      description: "Read the current persisted graph-planning projection and, when started, its canonical runtime projection. Use after recovery or graph completion before synthesizing the final response.",
      inputSchema: getSchema,
      handler: async (raw) => {
        getSchema.parse(raw);
        const inspection = input.coordinator.inspection(input.workItemId, input.primaryRunKey);
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
      description: "Read a bounded chunk of a current committed graph artifact after get_graph_plan identifies its artifact ID. Reads are WorkItem- and run-scoped, reject stale or secret artifacts, and never expose server storage paths.",
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
  ];
}
