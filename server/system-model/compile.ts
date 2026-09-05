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
import { LOW_CONFIDENCE_FALLBACK, type MatchCandidate } from "./match.ts";
import { computePacketApplicability } from "./applicability.ts";
import { expandScope, pathsOverlap, type ExpandedScope } from "./compile-scope.ts";
import type { LoadedSystemModel } from "./types.ts";
import { initializeWorkPacketState } from "./work-packet-state.ts";
import { reviewGateMatches } from "./review-gates.ts";

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
  entryPoints?: Array<{ capabilityId: string; surfaceId: string }>;
  acceptanceCriteria?: string[];
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
  const taskFiles = unique([...(input.taskFiles ?? []), ...(input.ownedPaths ?? [])]);
  const seeds = new Set(input.matchedCandidates.map((candidate) => candidate.id));
  const expanded = expandScope(input.model, [...seeds], taskFiles);
  const selectedSurfaces = input.matchedCandidates.filter((candidate) => candidate.type === "surface").map((candidate) => candidate.id);
  const entryPoints = expanded.capabilities.flatMap((capability) =>
    (capability.entryPoints ?? []).filter((entryPoint) => {
      const confirmed = input.entryPoints?.filter((entry) => entry.capabilityId === capability.id);
      if (confirmed?.length) return confirmed.some((entry) => entry.surfaceId === entryPoint.surface);
      if (selectedSurfaces.length) return selectedSurfaces.includes(entryPoint.surface);
      if (taskFiles.length) return entryPoint.files.some((glob) => taskFiles.some((file) => pathsOverlap(glob, file)));
      return seeds.has(capability.id) || entryPoint.flows.some((id) => seeds.has(id));
    }).map((entryPoint) => ({
      capabilityId: capability.id,
      surfaceId: entryPoint.surface,
      files: entryPoint.files,
      tests: entryPoint.tests,
      flows: entryPoint.flows,
    }))).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId) || a.surfaceId.localeCompare(b.surfaceId));
  const suggestedFiles = unique([
    ...expanded.capabilities.flatMap((c) => c.suggestedFiles),
    ...expanded.flows.flatMap((f) => f.suggestedFiles),
    ...expanded.surfaces.filter((s) => seeds.has(s.id)).flatMap((s) => s.suggestedFiles),
    ...entryPoints.flatMap((entryPoint) => entryPoint.files),
    ...(input.taskFiles ?? []),
  ]);
  const suggestedTests = unique([
    ...expanded.capabilities.flatMap((c) => c.suggestedTests),
    ...expanded.flows.flatMap((f) => f.suggestedTests),
    ...expanded.surfaces.filter((s) => seeds.has(s.id)).flatMap((s) => s.suggestedTests),
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
    surfaces: unique([...selectedSurfaces, ...entryPoints.map((entry) => entry.surfaceId)]),
    entryPoints,
    suggestedFiles,
    suggestedTests,
  };
  const packetRequired = derivePacketRequired(input.model, {
    files: taskFiles.length ? taskFiles : suggestedFiles,
    capabilities: scope.capabilities,
    flows: scope.flows,
  });
  const riskConstraints = expanded.constraints.filter((constraint) => seeds.has(constraint.id)
    || constraint.scope === "targeted"
    || constraint.appliesTo.files.some((glob) => taskFiles.some((file) => pathsOverlap(glob, file))));
  const riskLevel = maxRisk([...expanded.capabilities, ...expanded.flows, ...riskConstraints, ...expanded.risks]);
  const reviewGates = deriveReviewGateRequirements(input.model, scope.capabilities, scope.flows, taskFiles, riskLevel);
  const base = input.existingPacket;
  const initialState = base ?? initializeWorkPacketState(input.acceptanceCriteria, input.now);
  const packet: WorkPacket = {
    id: base?.id ?? input.packetId ?? "packet.generated",
    leaderSessionKey: base?.leaderSessionKey ?? input.leaderSessionKey ?? "leader.generated",
    createdAt: base?.createdAt ?? input.now,
    userRequest: input.userRequest,
    normalizedGoal: input.normalizedGoal,
    status: input.amendment ? "amended" : "draft",
    selection: { objectIds: [...seeds], taskFiles: input.taskFiles ?? [], ownedPaths: input.ownedPaths ?? [], entryPoints: input.entryPoints ?? [] },
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
    riskLevel,
    matchConfidence: input.matchConfidence,
    criterionCoverage: initialState.criterionCoverage ?? [],
    evidenceLedger: initialState.evidenceLedger ?? [],
    signals: initialState.signals ?? [],
    amendments: input.amendment
      ? [...(base?.amendments ?? []), { at: input.now, reason: input.amendment.reason, delta: input.amendment.delta }]
      : (base?.amendments ?? []),
  };
  return {
    packet,
    contextPack: renderWorkPacketContextPack(input.model, packet),
    packetRequired,
    freshnessReport,
  };
}

export function renderWorkPacketContextPack(
  model: LoadedSystemModel,
  packet: WorkPacket,
): string {
  const expanded: ExpandedScope = {
    capabilities: model.capabilities.filter((item) => packet.scope.capabilities.includes(item.id)),
    flows: model.flows.filter((item) => packet.scope.flows.includes(item.id)),
    surfaces: model.surfaces.filter((item) => (packet.scope.surfaces ?? []).includes(item.id)),
    constraints: model.constraints.filter((item) => packet.scope.constraints.includes(item.id)),
    decisions: model.decisions.filter((item) => packet.scope.decisions.includes(item.id)),
    risks: model.risks.filter((item) => packet.scope.risks.includes(item.id)),
  };
  return renderContextPack(model.policies.contextBudgets, expanded, packet);
}

function renderContextPack(
  budget: ContextBudget,
  expanded: ExpandedScope,
  packet: WorkPacket,
): string {
  const chunks = [
    CONTEXT_PACK_PREAMBLE,
    packet.matchConfidence === "low" ? `Fallback: ${LOW_CONFIDENCE_FALLBACK}` : "",
  ].filter(Boolean);
  const recentEvidence = [...(packet.evidenceLedger ?? [])]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);
  const objects: Array<{ id: string; text: string }> = [
    { id: "task-goal", text: `Task: ${packet.normalizedGoal}` },
    ...packet.agentInstructions
      .filter((instruction) => !expanded.constraints.some((constraint) =>
        constraint.agentInstruction === instruction))
      .map((instruction, index) => ({
      id: `packet-instruction-${index + 1}`,
      text: `Freshness instruction: ${instruction}`,
      })),
    ...(packet.signals ?? [])
      .filter((signal) => signal.status === "open")
      .sort((a, b) => riskRank(b.priority) - riskRank(a.priority) || a.id.localeCompare(b.id))
      .map((signal) => ({ id: signal.id, text: `Open ${signal.priority} signal ${signal.id}: ${signal.summary}` })),
    ...(packet.criterionCoverage ?? []).map((coverage) => ({
      id: coverage.criterionId,
      text: `Criterion ${coverage.criterionId} [${coverage.status}]: ${coverage.criterion}; evidence ${coverage.evidenceRefs.join(", ") || "none"}`,
    })),
    ...expanded.capabilities.map((o) => ({ id: o.id, text: `Capability ${o.id}: ${o.summary}` })),
    ...expanded.flows.map((o) => ({ id: o.id, text: `Flow ${o.id}: ${o.summary}` })),
    ...[...expanded.constraints].sort((a, b) => riskRank(b.severity) - riskRank(a.severity) || a.id.localeCompare(b.id)).map((o) =>
      ({ id: o.id, text: `Constraint ${o.id}: ${o.statement}${o.agentInstruction ? ` Instruction: ${o.agentInstruction}` : ""}` })),
    ...(packet.scope.entryPoints ?? []).map((entryPoint) =>
      ({ id: `${entryPoint.capabilityId}.${entryPoint.surfaceId}`, text: `Entry point ${entryPoint.surfaceId} for ${entryPoint.capabilityId}: files ${entryPoint.files.join(", ") || "none"}; tests ${entryPoint.tests.join(", ") || "none"}` })),
    ...recentEvidence.map((evidence) => ({
      id: evidence.id,
      text: `Evidence ${evidence.id} [${evidence.provenance}/${evidence.kind}]: ${evidence.summary}`,
    })),
    ...packet.freshness.warnings.map((warning, index) => ({
      id: `freshness-warning-${index + 1}`,
      text: `Freshness warning: ${warning}`,
    })),
    ...packet.freshness.requiredVerifications.map((verification) => ({
      id: `verification-${verification.kind}-${verification.target}`,
      text: `Required verification [${verification.status}] ${verification.kind}/${verification.target}: ${verification.reason}`,
    })),
    ...expanded.decisions.map((o) => ({ id: o.id, text: `Decision ${o.id}: ${o.summary}` })),
    ...expanded.risks.map((o) => ({ id: o.id, text: `Risk ${o.id}: ${o.summary}${o.mitigation ? ` Mitigation: ${o.mitigation}` : ""}` })),
    { id: "suggested-files", text: `Suggested files: ${packet.scope.suggestedFiles.join(", ") || "none"}` },
    { id: "suggested-tests", text: `Suggested tests: ${packet.scope.suggestedTests.join(", ") || "none"}` },
  ];
  const omitted: string[] = [];
  for (const object of objects) {
    const line = trimToTokens(object.text, budget.perObjectSummary);
    if (estimatedTokens([...chunks, line].join("\n")) <= budget.minionContextPack) chunks.push(line);
    else omitted.push(object.id);
  }
  if (omitted.length > 0) {
    const fixedLines = packet.matchConfidence === "low" ? 2 : 1;
    let marker = omissionMarker(omitted);
    while (chunks.length > fixedLines && estimatedTokens([...chunks, marker].join("\n")) > budget.minionContextPack) {
      const removed = chunks.pop();
      if (removed) omitted.unshift("additional-context");
      marker = omissionMarker(omitted);
    }
    chunks.push(marker);
  }
  return chunks.join("\n");
}

function omissionMarker(ids: string[]): string {
  const shown = unique(ids).slice(0, 5);
  const remaining = Math.max(0, unique(ids).length - shown.length);
  return `[${ids.length} objects omitted by context budget: ${shown.join(", ")}${remaining ? `, +${remaining} more` : ""} — use query_system_model with ids]`;
}

function riskRank(level: RiskLevel): number {
  return ["low", "medium", "high", "critical"].indexOf(level);
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
  risk: RiskLevel,
): ReviewGateRequirement[] {
  return model.policies.reviewGates.map((gate) => {
    const required = reviewGateMatches(gate, { capabilities, flows, files, risk });
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
