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
  const suggestedFiles = unique([...expanded.capabilities.flatMap((c) => c.suggestedFiles), ...expanded.flows.flatMap((f) => f.suggestedFiles), ...(input.taskFiles ?? [])]);
  const suggestedTests = unique([...expanded.capabilities.flatMap((c) => c.suggestedTests), ...expanded.flows.flatMap((f) => f.suggestedTests), ...expanded.constraints.flatMap((c) => c.suggestedTests)]);
  const freshnessReport = await checkFreshness({
    cwd: input.cwd,
    headSha: input.headSha,
    mode: input.mode,
    subjects: [...expanded.capabilities, ...expanded.flows].map((object) => ({
      objectId: object.id,
      objectFile: input.objectFiles?.[object.id] ?? objectFileFor(object),
      globs: object.suggestedFiles,
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
    agentInstructions: unique(expanded.constraints.flatMap((c) => c.agentInstruction ? [c.agentInstruction] : [])),
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
    contextPack: renderContextPack(input.model.policies.contextBudgets, expanded, scope, input.matchConfidence),
    packetRequired,
    freshnessReport,
  };
}

function expandScope(model: LoadedSystemModel, candidateIds: string[]) {
  const capabilityIds = new Set(candidateIds.filter((id) => id.startsWith("capability.")));
  const flowIds = new Set(candidateIds.filter((id) => id.startsWith("flow.")));
  for (const capability of model.capabilities) if (capabilityIds.has(capability.id)) capability.linkedFlows.forEach((id) => flowIds.add(id));
  for (const flow of model.flows) if (flowIds.has(flow.id)) flow.capabilities.forEach((id) => capabilityIds.add(id));
  const capabilities = sortById(model.capabilities.filter((item) => capabilityIds.has(item.id)));
  const flows = sortById(model.flows.filter((item) => flowIds.has(item.id)));
  const ids = new Set([...capabilities, ...flows].map((item) => item.id));
  const constraints = sortById(model.constraints.filter((item) =>
    intersects(item.appliesTo.capabilities, [...capabilityIds]) || intersects(item.appliesTo.flows, [...flowIds])
    || capabilities.some((cap) => cap.constraints.includes(item.id)) || flows.some((flow) => flow.constraints.includes(item.id))));
  const decisions = sortById(model.decisions.filter((item) =>
    capabilities.some((cap) => cap.decisions.includes(item.id)) || flows.some((flow) => flow.decisions.includes(item.id))
    || constraints.some((constraint) => constraint.evidence.includes(item.id))));
  const risks = sortById(model.risks.filter((item) =>
    intersects(item.appliesTo.capabilities, [...capabilityIds]) || intersects(item.appliesTo.flows, [...flowIds])
    || capabilities.some((cap) => cap.risks.includes(item.id)) || flows.some((flow) => flow.risks.includes(item.id))));
  return { capabilities, flows, constraints, decisions, risks, ids };
}

function renderContextPack(
  budget: ContextBudget,
  expanded: ReturnType<typeof expandScope>,
  scope: WorkPacket["scope"],
  confidence: WorkPacket["matchConfidence"],
): string {
  const chunks = [
    CONTEXT_PACK_PREAMBLE,
    confidence === "low" ? `Fallback: ${LOW_CONFIDENCE_FALLBACK}` : "",
  ].filter(Boolean);
  const objects = [
    ...expanded.constraints.map((o) => `Constraint ${o.id}: ${o.statement}`),
    ...expanded.decisions.map((o) => `Decision ${o.id}: ${o.summary}`),
    ...expanded.flows.map((o) => `Flow ${o.id}: ${o.summary}`),
    ...expanded.capabilities.map((o) => `Capability ${o.id}: ${o.summary}`),
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
  return model.policies.reviewGates.some((gate) => scope.files.some((file) => gate.requiredWhen.files.some((glob) => globMatches(glob, file))))
    || model.constraints.some((constraint) => constraint.severity === "critical"
      && scope.files.some((file) => constraint.appliesTo.files.some((glob) => globMatches(glob, file))));
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

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}
