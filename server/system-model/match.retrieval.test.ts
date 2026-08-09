import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemModelObject } from "../../shared/system-model/index.ts";
import { createQuerySystemModelToolDef } from "../system-model-tools/query-system-model.ts";
import { compileWorkPacket } from "./compile.ts";
import { matchSystemModel, type MatchCandidate } from "./match.ts";
import type { LoadedSystemModel } from "./types.ts";

const OBJECTS = [
  { id: "domain.runtime", type: "domain", name: "Runtime subsystems", summary: "Focused categorical ownership.", keywords: ["architecture"] },
  capability("ws_command_bus", "WS command bus", ["flow.command_table_dispatch"], ["constraint.bus_only_broadcasts"], ["ws", "command", "handler"], ["server/commands/*.ts"]),
  capability("worktree_approval", "Worktree approval", ["flow.evaluate_merge_gates"], ["constraint.review_gated_merges"], ["merge", "approval", "gating"], ["server/commands/*merge*.ts"]),
  capability("render_dashboard", "Render dashboard", [], ["constraint.render_schema_gate"], ["render", "dsl", "schema"], ["shared/render-dsl.ts"]),
  capability("system_model", "System model", [], ["constraint.system_model_review", "constraint.system_model_boundaries"], ["touch", "shared/system-model", "types"], ["shared/system-model/*.ts"]),
  capability("canvas_workspace", "Canvas workspace", ["flow.render_canvas_nodes"], [], ["canvas", "nodes"], ["src/nodes/*.tsx"]),
  capability("task_delegation", "Task delegation", ["flow.assign_minion_skills"], [], ["task", "skill", "minion"], ["server/task-tools/*.ts"]),
  flow("command_table_dispatch", "Command handler dispatch", "Register WS command handler then dispatch typed payload", "capability.ws_command_bus", ["constraint.bus_only_broadcasts"], ["server/commands/*.ts"]),
  flow("evaluate_merge_gates", "Merge gate evaluation", "Change approval gating then evaluate merge review", "capability.worktree_approval", ["constraint.review_gated_merges"], ["server/commands/*merge*.ts"]),
  flow("render_canvas_nodes", "Canvas node rendering", "Paint node content inside canvas workspace", "capability.canvas_workspace", [], ["src/nodes/*.tsx"]),
  flow("assign_minion_skills", "Minion skill assignment", "Delegate task tools and select skill instructions", "capability.task_delegation", [], ["server/task-tools/*.ts"]),
  constraint("bus_only_broadcasts", "Command handler broadcasts use bus only", "Add WS command routes through typed bus", "capability.ws_command_bus", "flow.command_table_dispatch", ["server/commands/*.ts"]),
  constraint("review_gated_merges", "Merge approval requires review gating", "Change approval gating only through merge review", "capability.worktree_approval", "flow.evaluate_merge_gates", ["server/commands/*merge*.ts"]),
  constraint("render_schema_gate", "Render DSL schema edits require review", "Edit render schema through its review gate", "capability.render_dashboard", undefined, ["shared/render-dsl.ts"]),
  constraint("system_model_review", "Shared model types require review", "Touch shared/system-model types only with model review", "capability.system_model", undefined, ["shared/system-model/*.ts"]),
  constraint("system_model_boundaries", "System model types preserve boundaries", "Touch shared/system-model types without cross-tree leakage", "capability.system_model", undefined, ["shared/system-model/*.ts"], "high"),
  {
    id: "decision.typed_command_bus",
    type: "decision",
    title: "Typed command bus boundary",
    status: "accepted",
    summary: "Command payload routing stays centralized and typed",
    evidence: [],
  },
] satisfies SystemModelObject[];

const FROZEN_MODEL = deepFreeze(makeModel(OBJECTS));
const SUMMARY_BUDGET = FROZEN_MODEL.policies.contextBudgets.perObjectSummary;
const PACK_BUDGET = FROZEN_MODEL.policies.contextBudgets.minionContextPack;

interface RetrievalCase {
  request: string;
  files: string[];
  expected: string[];
  forbiddenPrefixes: string[];
  criticalConstraints: string[];
}

const CASES: RetrievalCase[] = [
  {
    request: "add a new WS command handler",
    files: ["server/commands/archive-session.ts"],
    expected: ["capability.ws_command_bus", "constraint.bus_only_broadcasts", "flow.command_table_dispatch"],
    forbiddenPrefixes: ["capability.task_", "flow.assign_", "capability.render_", "flow.render_"],
    criticalConstraints: ["constraint.bus_only_broadcasts"],
  },
  {
    request: "change merge approval gating",
    files: ["server/commands/merge-worktree.ts"],
    expected: ["capability.worktree_approval", "constraint.review_gated_merges", "flow.evaluate_merge_gates"],
    forbiddenPrefixes: ["capability.canvas_", "flow.render_", "capability.task_", "flow.assign_"],
    criticalConstraints: ["constraint.review_gated_merges"],
  },
  {
    request: "edit render DSL schema",
    files: ["shared/render-dsl.ts"],
    expected: ["capability.render_dashboard", "constraint.render_schema_gate"],
    forbiddenPrefixes: ["capability.system_", "flow.command_", "flow.evaluate_"],
    criticalConstraints: ["constraint.render_schema_gate"],
  },
  {
    request: "touch shared/system-model types",
    files: ["shared/system-model/objects.ts"],
    expected: ["capability.system_model", "constraint.system_model_boundaries", "constraint.system_model_review"],
    forbiddenPrefixes: ["flow.", "capability.canvas_", "capability.task_"],
    criticalConstraints: ["constraint.system_model_review"],
  },
];

describe("system-model retrieval quality fixture", () => {
  let projectPath: string;

  beforeAll(() => {
    projectPath = mkdtempSync(path.join(tmpdir(), "minions-retrieval-"));
  });

  afterAll(() => rmSync(projectPath, { recursive: true, force: true }));

  it.each(CASES)("selects the smallest relevant set for '$request'", async (fixture) => {
    const result = matchSystemModel({
      model: FROZEN_MODEL,
      request: fixture.request,
      files: fixture.files,
      topK: fixture.expected.length,
    });
    const hitIds = result.candidates.map((candidate) => candidate.id);

    expect(precisionAtK(hitIds, fixture.expected)).toBe(1);
    expect(new Set(hitIds)).toEqual(new Set(fixture.expected));
    expect(hitIds.some((id) => fixture.forbiddenPrefixes.some((prefix) => id.startsWith(prefix)))).toBe(false);
    expect(result.matchConfidence).toBe("high");

    const compiled = await compile(fixture, result.candidates);
    expect(compiled.packet.scope.constraints).toEqual(expect.arrayContaining(fixture.criticalConstraints));
    expect(estimatedTokens(compiled.contextPack)).toBeLessThanOrEqual(PACK_BUDGET);
    expect(compiled.freshnessReport.objects.map((object) => object.objectId)).toEqual(
      expect.arrayContaining(result.candidates.filter((hit) => hit.type === "capability" || hit.type === "flow").map((hit) => hit.id)),
    );
    expect(compiled.freshnessReport.objects.every((object) => object.status === "stale")).toBe(true);

    const payload = await query(projectPath, fixture.request, fixture.expected.length);
    expect(payload.matches.every((match) => estimatedTokens(match.summary) <= SUMMARY_BUDGET)).toBe(true);
    expect(intersection(payload.matches.map((match) => match.id), payload.linked.map((stub) => stub.id))).toEqual([]);
    expect(new Set(payload.linked.map((stub) => stub.id)).size).toBe(payload.linked.length);
  });

  it("returns an empty low-confidence fallback for an unrelated README typo", async () => {
    const result = matchSystemModel({ model: FROZEN_MODEL, request: "fix a typo in README", topK: 5 });

    expect(result.candidates).toEqual([]);
    expect(result.matchConfidence).toBe("low");
    expect(result.fallbackInstruction).toBe("inspect repo; ask only if required");

    const payload = await query(projectPath, "fix a typo in README", 5);
    expect(payload.matches).toEqual([]);
    expect(payload.linked).toEqual([]);
    expect(payload.matchConfidence).toBe("low");
    expect(payload.fallbackInstruction).toBe("inspect repo; ask only if required");
  });
});

async function compile(fixture: RetrievalCase, candidates: MatchCandidate[]) {
  return compileWorkPacket({
    model: FROZEN_MODEL,
    cwd: "/frozen-fixture",
    headSha: "fixture-sha",
    mode: "advisory",
    userRequest: fixture.request,
    normalizedGoal: fixture.request,
    matchedCandidates: candidates,
    matchConfidence: "high",
    taskFiles: fixture.files,
    timestampFn: async () => ({ modelTouchedAt: 10, codeTouchedAt: 20 }),
    now: 30,
  });
}

async function query(projectPath: string, request: string, topK: number): Promise<QueryPayload> {
  const tool = createQuerySystemModelToolDef({
    leaderSessionKey: "retrieval-fixture",
    projectPath,
    cwd: projectPath,
    runtime: { mode: "advisory", manifestFound: true, model: FROZEN_MODEL, loadErrors: [] },
    bus: { emit: () => {}, emitToSession: () => {}, emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
  });
  const result = await tool.handler({ query: request, topK });
  return JSON.parse(result.content[0]!.text) as QueryPayload;
}

interface QueryPayload {
  matches: Array<{ id: string; summary: string }>;
  linked: Array<{ id: string; type: string; label: string; why: string }>;
  matchConfidence: string;
  fallbackInstruction?: string;
}

function capability(id: string, name: string, _flows: string[], constraints: string[], keywords: string[], suggestedFiles: string[]): SystemModelObject {
  return { id: `capability.${id}`, type: "capability", domain: "domain.runtime", name, summary: `${name} owns focused runtime behavior`, dependsOn: [], bridges: [], constraints, decisions: [], risks: [], suggestedFiles, suggestedTests: [], keywords, entryPoints: [], freshness: { class: "code_coupled" }, risk: "medium" };
}

function flow(id: string, name: string, steps: string, capabilityId: string, constraints: string[], suggestedFiles: string[]): SystemModelObject {
  return { id: `flow.${id}`, type: "flow", domain: "domain.runtime", name, summary: `${name} coordinates focused runtime behavior`, primaryCapability: capabilityId, bridges: [], constraints, decisions: [], risks: [], suggestedFiles, suggestedTests: [], steps: [steps], freshness: { class: "code_coupled" }, risk: "medium" };
}

function constraint(id: string, statement: string, agentInstruction: string, capabilityId: string, flowId: string | undefined, files: string[], severity: "high" | "critical" = "critical"): SystemModelObject {
  return { id: `constraint.${id}`, type: "constraint", domain: "domain.runtime", scope: "targeted", guards: [capabilityId, ...(flowId ? [flowId] : [])], statement, appliesTo: { capabilities: [capabilityId], flows: flowId ? [flowId] : [], surfaces: [], files }, severity, agentInstruction, suggestedTests: [], evidence: [] };
}

function makeModel(objects: SystemModelObject[]): LoadedSystemModel {
  const domains = objects.filter((object) => object.type === "domain");
  const capabilities = objects.filter((object) => object.type === "capability");
  const flows = objects.filter((object) => object.type === "flow");
  const constraints = objects.filter((object) => object.type === "constraint");
  const decisions = objects.filter((object) => object.type === "decision");
  const risks = objects.filter((object) => object.type === "risk");
  const surfaces = objects.filter((object) => object.type === "surface");
  const reviewGates = [
    { id: "gate.merge_review", name: "Merge review", blocksMerge: true, requiredWhen: { files: ["server/commands/*merge*.ts"], capabilities: [], flows: [], risk: [] } },
    { id: "gate.render_schema", name: "Render schema review", blocksMerge: true, requiredWhen: { files: ["shared/render-dsl.ts"], capabilities: [], flows: [], risk: [] } },
  ];
  return {
    root: "/frozen-fixture",
    manifestPath: "/frozen-fixture/.systemmodel/manifest.yaml",
    manifest: { fixture: "retrieval-quality-v1" },
    domains,
    capabilities,
    flows,
    constraints,
    decisions,
    risks,
    surfaces,
    policies: { freshness: [], reviewGates, contextBudgets: { leaderPromptAddendum: 120, minionContextPack: 220, perObjectSummary: 24 } },
    objectsById: new Map(objects.map((object) => [object.id, object])),
    reviewGatesById: new Map(reviewGates.map((gate) => [gate.id, gate])),
  };
}

function precisionAtK(actual: string[], expected: string[]): number {
  return intersection(actual, expected).length / actual.length;
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
