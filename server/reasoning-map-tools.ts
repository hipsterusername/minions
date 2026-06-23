import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import { jsonResult } from "./harness/tool-result.ts";
import type { RenderComponent } from "../shared/render-dsl.ts";
import {
  applyReasoningOps,
  closeReasoningMap,
  createReasoningMap,
  recordReasoningChallenge,
  summarizeReasoningMap,
  validateReasoningMap,
  type ChallengeClassification,
  type ClaimBasis,
  type Confidence,
  type ReasoningMap,
  type ReasoningMapState,
  type ReasoningOp,
} from "../shared/reasoning-map.ts";
import { buildReasoningMapDashboardSection } from "../shared/reasoning-map-dashboard.ts";

export type { ReasoningMapState } from "../shared/reasoning-map.ts";

const basisSchema = z.enum(["observed", "inferred", "assumed", "user_confirmed"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);
const classificationSchema = z.enum([
  "misunderstanding",
  "missing_evidence",
  "conflicting_evidence",
  "changed_requirement",
  "bad_assumption",
]);

const createMapSchema = z.object({
  mapId: z.string().optional(),
  title: z.string(),
  outcome: z.object({
    id: z.string().optional(),
    title: z.string(),
    summary: z.string(),
    successSignal: z.string(),
    basis: basisSchema.optional(),
    confidence: confidenceSchema.optional(),
  }),
});

const applyOpsSchema = z.object({
  mapId: z.string().optional(),
  ops: z.array(z.looseObject({ op: z.string() })),
});

const mapSelectorSchema = z.object({
  mapId: z.string().optional(),
});

const challengeSchema = z.object({
  mapId: z.string().optional(),
  nodeId: z.string(),
  userText: z.string(),
  classification: classificationSchema.optional(),
  resolution: z.string().optional(),
});

const summarizeSchema = z.object({
  mapId: z.string().optional(),
  budget: z.number().int().positive().optional(),
});

const closeSchema = z.object({
  mapId: z.string().optional(),
  summary: z.string().optional(),
});

export function createReasoningMapToolsForLeader(opts: {
  existingReasoningMapState?: ReasoningMapState | null;
  onStateChange?: (state: ReasoningMapState) => void;
  onDashboardUpdate?: (components: RenderComponent[]) => void;
}): { toolDefs: NormalizedToolDef[]; reasoningMapState: ReasoningMapState } {
  const reasoningMapState: ReasoningMapState = opts.existingReasoningMapState ?? {
    maps: [],
  };

  function notify(map: ReasoningMap): void {
    opts.onStateChange?.(reasoningMapState);
    opts.onDashboardUpdate?.([
      buildReasoningMapDashboardSection(map, validateReasoningMap(map)),
    ]);
  }

  function select(mapId?: string): ReasoningMap {
    const id = mapId ?? reasoningMapState.activeMapId;
    if (!id) throw new Error("No active reasoning map. Call create_reasoning_map first.");
    const map = reasoningMapState.maps.find((candidate) => candidate.id === id);
    if (!map) throw new Error(`Reasoning map not found: ${id}`);
    return map;
  }

  function replace(map: ReasoningMap): void {
    const idx = reasoningMapState.maps.findIndex((candidate) => candidate.id === map.id);
    if (idx < 0) reasoningMapState.maps.push(map);
    else reasoningMapState.maps[idx] = map;
    reasoningMapState.activeMapId = map.status === "active" ? map.id : undefined;
    notify(map);
  }

  const createTool: NormalizedToolDef = {
    name: "create_reasoning_map",
    description:
      "Start session-scoped Reasoning Graph state for non-trivial work. Seed it with the user-visible outcome and success signal.",
    inputSchema: createMapSchema,
    handler: async (input) => {
      const args = createMapSchema.parse(input);
      const mapId = args.mapId ?? `reasoning-map-${reasoningMapState.maps.length + 1}`;
      if (reasoningMapState.maps.some((map) => map.id === mapId)) {
        throw new Error(`Reasoning map already exists: ${mapId}`);
      }
      const map = createReasoningMap({
        id: mapId,
        title: args.title,
        outcome: {
          ...args.outcome,
          basis: (args.outcome.basis ?? "user_confirmed") as ClaimBasis,
          confidence: (args.outcome.confidence ?? "medium") as Confidence,
        },
      });
      replace(map);
      return textResult({ mapId, validation: validateReasoningMap(map) });
    },
  };

  const applyTool: NormalizedToolDef = {
    name: "apply_reasoning_ops",
    description:
      "Batch add, revise, link, and bind Reasoning Graph artifacts. Invalid operations and validation errors are rejected without mutating state.",
    inputSchema: applyOpsSchema,
    handler: async (input) => {
      const args = applyOpsSchema.parse(input);
      const current = select(args.mapId);
      const result = applyReasoningOps(current, args.ops as ReasoningOp[]);
      if (!result.validation.ok) {
        return textResult(
          { error: "Reasoning ops rejected", validation: result.validation },
          true,
        );
      }
      replace(result.map);
      return textResult(result);
    },
  };

  const validateTool: NormalizedToolDef = {
    name: "validate_reasoning_map",
    description:
      "Validate semantic quality of the active Reasoning Graph, including unsupported claims, contradictions, and unresolved risk.",
    inputSchema: mapSelectorSchema,
    annotations: { readOnlyHint: true },
    handler: async (input) => {
      const args = mapSelectorSchema.parse(input);
      return textResult(validateReasoningMap(select(args.mapId)));
    },
  };

  const challengeTool: NormalizedToolDef = {
    name: "challenge_reasoning_node",
    description:
      "Record a user challenge against a visible reasoning node. The user challenge is auditable and must be resolved by adding evidence, revising, refuting, branching, or asking a clarification.",
    inputSchema: challengeSchema,
    handler: async (input) => {
      const args = challengeSchema.parse(input);
      const map = recordReasoningChallenge(select(args.mapId), {
        id: `challenge-${Date.now()}`,
        nodeId: args.nodeId,
        userText: args.userText,
        classification: args.classification as ChallengeClassification | undefined,
        resolution: args.resolution,
      });
      replace(map);
      return textResult({
        challenge: map.challenges.at(-1),
        validation: validateReasoningMap(map),
      });
    },
  };

  const summarizeTool: NormalizedToolDef = {
    name: "summarize_reasoning_map",
    description:
      "Produce a compact summary of the active Reasoning Graph for completion, recovery, or future context.",
    inputSchema: summarizeSchema,
    annotations: { readOnlyHint: true },
    handler: async (input) => {
      const args = summarizeSchema.parse(input);
      return textResult(summarizeReasoningMap(select(args.mapId), args.budget));
    },
  };

  const closeTool: NormalizedToolDef = {
    name: "close_reasoning_map",
    description:
      "Validate and close the active Reasoning Graph with a final summary. Closed maps remain persisted but are not re-opened automatically.",
    inputSchema: closeSchema,
    handler: async (input) => {
      const args = closeSchema.parse(input);
      const current = select(args.mapId);
      const validation = validateReasoningMap(current);
      if (!validation.ok) {
        return textResult({ error: "Cannot close invalid reasoning map", validation }, true);
      }
      const summary = args.summary ?? summarizeReasoningMap(current).summary;
      const closed = closeReasoningMap(current, summary);
      replace(closed);
      return textResult({ mapId: closed.id, summary, validation });
    },
  };

  return {
    toolDefs: [
      createTool,
      applyTool,
      validateTool,
      challengeTool,
      summarizeTool,
      closeTool,
    ],
    reasoningMapState,
  };
}

// Compact, null-stripped JSON — see server/harness/tool-result.ts for the
// token-efficiency rationale.
function textResult(value: unknown, isError = false) {
  return jsonResult(value, { isError });
}
