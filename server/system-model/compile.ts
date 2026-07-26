import type {
  Capability,
  Constraint,
  ContextBudget,
  Flow,
  ReviewGateRequirement,
  Risk,
  RiskLevel,
  WorkPacket,
} from "../../shared/system-model/index.ts";
import { checkFreshness, type FreshnessReport, type FreshnessTimestampFn } from "./freshness.ts";
import { globMatches, LOW_CONFIDENCE_FALLBACK, type MatchCandidate } from "./match.ts";
import { computePacketApplicability } from "./applicability.ts";
import { expandScope, type ExpandedScope } from "./compile-scope.ts";
import type { LoadedSystemModel } from "./types.ts";

export const CONTEXT_PACK_PREAMBLE =
  "Suggested files are hints, not truth. Inspect current code before editing. Hard constraints override implementation convenience. If current code contradicts this context, report the conflict.";

export interface CompileInput {
  model: LoadedSystemModel;
  cwd: string;
  headSha: string;
  mode: "advisory" | "enforced";
  userRequest: string;
  normalizedGoal: string;
  matchedCandidates: MatchCandidate[];
  matchConfidence: WorkPacket["matchConfidence"];
  taskFiles?: string[];
  ownedPaths?: string[];
  timestampFn: FreshnessTimestampFn;
  now: number;
  packetId?: string;
  leaderSessionKey?: string;
  objectFiles?: Record<string, string>;
  verifiedFreshnessTargets?: string[];
  existingPacket?: WorkPacket;
  amendment?: { reason: string; delta: string };
}

export interface CompiledWorkPacket {
  packet: WorkPacket;
  contextPack: string;
  packetRequired: boolean;
  freshnessReport: FreshnessReport;
}

export async function compileWorkPacket(input: CompileInput): Promise<CompiledWorkPacket> {
  const expanded = expandScope(input.model, input.matchedCandidates.map((candidate) => candidate.id));
  const entryPoints = expanded.capabilities.flatMap((capability) =>
    (capability.entryPoints ?? []).map((entryPoint) => ({
      capabilityId: capability.id,
      surfaceId: entryPoint.surface,
      files: entryPoint.files,
      tests: entryPoint.tests,
      flows: entryPoint.flows,
    }))).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId) || a.surfaceId.localeCompare(b.surfaceId));
  const suggestedFiles = unique([
    ...expanded.capabilities.flatMap((c) => c.suggestedFiles),
    ...expanded.flows.flatMap((f) => f.suggestedFiles),
    ...expanded.surfaces.flatMap((s) => s.suggestedFiles),
    ...entryPoints.flatMap((entryPoint) => entryPoint.files),
    ...(input.taskFiles ?? []),
  ]);
  const suggestedTests = unique([
    ...expanded.capabilities.flatMap((c) => c.suggestedTests),
    ...expanded.flows.flatMap((f) => f.suggestedTests),
    ...expanded.surfaces.flatMap((s) => s.suggestedTests),
    ...expanded.constraints.flatMap((c) => c.suggestedTests),
    ...entryPoints.flatMap((entryPoint) => entryPoint.tests),
  ]);
  const freshnessReport = await checkFreshness({
    cwd: input.cwd,
    headSha: input.headSha,
    mode: input.mode,
    subjects: [...expanded.capabilities, ...expanded.flows].map((object) => ({
      objectId: object.id,
      objectFile: input.objectFiles?.[object.id] ?? objectFileFor(object),
      globs: object.type === "capability"
        ? unique([...object.suggestedFiles, ...(object.entryPoints ?? []).flatMap((entryPoint) => entryPoint.files)])
        : object.suggestedFiles,
      freshnessClass: object.freshness?.class,
      policyClass: "ordinary",
    })),
    policies: input.model.policies.freshness,
    getTimestamps: input.timestampFn,
    verifiedTargets: input.verifiedFreshnessTargets,
  });
  const scope = {
    capabilities: expanded.capabilities.map((item) => item.id),
    flows: expanded.flows.map((item) => item.id),
    constraints: expanded.constraints.map((item) => item.id),
    decisions: expanded.decisions.map((item) => item.id),
    risks: expanded.risks.map((item) => item.id),
    surfaces: expanded.surfaces.map((item) => item.id),
    entryPoints,
    suggestedFiles,
    suggestedTests,
  };
  const packetRequired = derivePacketRequired(input.model, {
    files: unique([...(input.taskFiles ?? []), ...(input.ownedPaths ?? []), ...suggestedFiles]),
    capabilities: scope.capabilities,
    flows: scope.flows,
  });
  const reviewGates = deriveReviewGateRequirements(input.model, scope.capabilities, scope.flows, suggestedFiles);
  const base = input.existingPacket;
  const packet: WorkPacket = {
    id: base?.id ?? input.packetId ?? "packet.generated",
    leaderSessionKey: base?.leaderSessionKey ?? input.leaderSessionKey ?? "leader.generated",
    createdAt: base?.createdAt ?? input.now,
    userRequest: input.userRequest,
    normalizedGoal: input.normalizedGoal,
    status: input.amendment ? "amended" : "draft",
    scope,
    nonGoals: base?.nonGoals ?? [],
    agentInstructions: unique([
      ...expanded.constraints.flatMap((c) => c.agentInstruction ? [c.agentInstruction] : []),
      ...freshnessReport.requiredAgentActions,
    ]),
    freshness: {
      status: freshnessReport.status,
      warnings: freshnessReport.warnings,
      requiredVerifications: freshnessReport.requiredVerifications,
    },
    reviewGates,
    riskLevel: maxRisk([...expanded.capabilities, ...expanded.flows, ...expanded.constraints, ...expanded.risks]),
    matchConfidence: input.matchConfidence,
    amendments: input.amendment
      ? [...(base?.amendments ?? []), { at: input.now, reason: input.amendment.reason, delta: input.amendment.delta }]
      : (base?.amendments ?? []),
  };
  return {
    packet,
    contextPack: renderContextPack(
      input.model.policies.contextBudgets,
      expanded,
      scope,
      input.matchConfidence,
      freshnessReport.requiredAgentActions,
    ),
    packetRequired,
    freshnessReport,
  };
}

function renderContextPack(
  budget: ContextBudget,
  expanded: ExpandedScope,
  scope: WorkPacket["scope"],
  confidence: WorkPacket["matchConfidence"],
  freshnessActions: string[],
): string {
  const chunks = [
    CONTEXT_PACK_PREAMBLE,
    confidence === "low" ? `Fallback: ${LOW_CONFIDENCE_FALLBACK}` : "",
  ].filter(Boolean);
  const objects = [
    ...expanded.constraints.flatMap((o) => [
      `Constraint ${o.id}: ${o.statement}`,
      ...(o.agentInstruction ? [`Instruction ${o.id}: ${o.agentInstruction}`] : []),
    ]),
    ...freshnessActions.map((action) => `Freshness instruction: ${action}`),
    ...expanded.decisions.map((o) => `Decision ${o.id}: ${o.summary}`),
    ...expanded.flows.map((o) => `Flow ${o.id}: ${o.summary}`),
    ...expanded.capabilities.map((o) => `Capability ${o.id}: ${o.summary}`),
    ...expanded.capabilities.flatMap((capability) => (capability.entryPoints ?? []).map((entryPoint) =>
      `Entry point ${entryPoint.surface} for ${capability.id}: files ${entryPoint.files.join(", ") || "none"}; tests ${entryPoint.tests.join(", ") || "none"}`)),
    `Suggested files: ${scope.suggestedFiles.join(", ") || "none"}`,
    `Suggested tests: ${scope.suggestedTests.join(", ") || "none"}`,
  ];
  let omitted = 0;
  for (const object of objects) {
    const line = trimToTokens(object, budget.perObjectSummary);
    if (estimatedTokens([...chunks, line].join("\n")) <= budget.minionContextPack) chunks.push(line);
    else omitted += 1;
  }
  if (omitted > 0) {
    const marker = `[${omitted} objects omitted by context budget — use query_system_model]`;
    const fixedLines = confidence === "low" ? 2 : 1;
    while (chunks.length > fixedLines && estimatedTokens([...chunks, marker].join("\n")) > budget.minionContextPack) {
      chunks.pop();
      omitted += 1;
    }
    chunks.push(`[${omitted} objects omitted by context budget — use query_system_model]`);
  }
  return chunks.join("\n");
}

function derivePacketRequired(model: LoadedSystemModel, scope: { files: string[]; capabilities: string[]; flows: string[] }): boolean {
  // Single source of truth for the gate/critical-constraint intersection —
  // shared with the plan_task / assign_task structural trigger (redesign §5).
  return computePacketApplicability(model, scope.files).packetRequired;
}

function deriveReviewGateRequirements(
  model: LoadedSystemModel,
  capabilities: string[],
  flows: string[],
  files: string[],
): ReviewGateRequirement[] {
  return model.policies.reviewGates.map((gate) => {
    const required = intersects(gate.requiredWhen.capabilities, capabilities)
      || intersects(gate.requiredWhen.flows, flows)
      || files.some((file) => gate.requiredWhen.files.some((glob) => globMatches(glob, file)));
    return { gateId: gate.id, name: gate.name, status: required ? "required_pending" : "not_required", reason: required ? "Matched packet scope" : "No scope match" };
  });
}

function objectFileFor(object: Capability | Flow): string {
  return `.systemmodel/${object.type === "capability" ? "capabilities" : "flows"}/${object.id.split(".")[1]}.yaml`;
}

function maxRisk(objects: Array<Capability | Flow | Constraint | Risk>): RiskLevel {
  const order: RiskLevel[] = ["low", "medium", "high", "critical"];
  return objects.reduce<RiskLevel>((max, object) => {
    const level = object.type === "capability" || object.type === "flow" ? object.risk : object.severity;
    return order.indexOf(level) > order.indexOf(max) ? level : max;
  }, "low");
}

function trimToTokens(text: string, tokens: number): string {
  const maxChars = tokens * 4;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function intersects(a: string[], b: string[]): boolean {
  const bSet = new Set(b);
  return a.some((item) => bSet.has(item));
}
