import type { WorkPacket, ReviewGateRequirement } from "../../shared/system-model/index.ts";
import type { DetailedDiff } from "../worktree-types.ts";
import { globMatches } from "./match.ts";
import { reviewGateMatches } from "./review-gates.ts";
import type { LoadedSystemModel } from "./types.ts";
import type { DeterministicReconciliation } from "../../shared/system-model/reconcile.ts";

export interface ReconcileInput {
  diff: DetailedDiff;
  model: LoadedSystemModel;
  packet: WorkPacket;
}

export function reconcileDeterministic(input: ReconcileInput): DeterministicReconciliation {
  const changedFiles = unique(input.diff.files.map((file) => file.file));
  const affectedCapabilities = input.model.capabilities
    .filter((capability) => changedFiles.some((file) => matchesAny(file, capability.suggestedFiles)))
    .map((capability) => capability.id);
  const affectedFlows = input.model.flows
    .filter((flow) => changedFiles.some((file) => matchesAny(file, flow.suggestedFiles)))
    .map((flow) => flow.id);
  const changedModelFiles = changedFiles.filter((file) => file.startsWith(".systemmodel/"));
  const affectedEntryPoints = input.model.capabilities.flatMap((capability) =>
    (capability.entryPoints ?? [])
      .filter((entryPoint) => changedFiles.some((file) => matchesAny(file, entryPoint.files)))
      .map((entryPoint) => ({ capabilityId: capability.id, surfaceId: entryPoint.surface })));
  const affectedEntryPointCapabilities = unique(affectedEntryPoints.map((item) => item.capabilityId));
  const candidateModelObjects = unique([
    ...affectedCapabilities,
    ...affectedFlows,
    ...affectedEntryPointCapabilities,
  ]);
  const siblingSurfaces = affectedEntryPointCapabilities.map((capabilityId) => ({
    capabilityId,
    surfaceIds: unique(input.model.capabilities.find((item) => item.id === capabilityId)
      ?.entryPoints.map((entryPoint) => entryPoint.surface) ?? []),
  }));
  const scopeCapabilities = unique([
    ...input.packet.scope.capabilities,
    ...affectedCapabilities,
    ...affectedEntryPointCapabilities,
  ]);
  const scopeFlows = unique([...input.packet.scope.flows, ...affectedFlows]);
  const scopeSurfaces = unique([
    ...(input.packet.scope.surfaces ?? []),
    ...affectedEntryPoints.map((item) => item.surfaceId),
    ...siblingSurfaces.flatMap((item) => item.surfaceIds),
  ]);
  const constraintsInScope = input.model.constraints
    .filter((constraint) =>
      input.packet.scope.constraints.includes(constraint.id)
      || intersects(constraint.appliesTo.capabilities, scopeCapabilities)
      || intersects(constraint.appliesTo.flows, scopeFlows)
      || intersects(constraint.appliesTo.surfaces, scopeSurfaces)
      || changedFiles.some((file) => matchesAny(file, constraint.appliesTo.files)))
    .map((constraint) => constraint.id);
  const changedTests = new Set(changedFiles.filter(isLikelyTestFile));
  const testsMissing = input.packet.scope.suggestedTests
    .filter((test) => !changedTests.has(test))
    .sort();
  const outOfScopeFiles = changedFiles
    .filter((file) => !matchesAny(file, input.packet.scope.suggestedFiles)
      && !input.packet.scope.suggestedTests.includes(file))
    .sort();
  const gateRequirements = deriveGateRequirements(input.model, {
    capabilities: scopeCapabilities,
    flows: scopeFlows,
    files: changedFiles,
    risk: input.packet.riskLevel,
  });
  return {
    provenance: "deterministic",
    changedFiles,
    affectedCapabilities: unique([...affectedCapabilities, ...affectedEntryPointCapabilities]),
    affectedFlows: affectedFlows.sort(),
    candidateModelObjects,
    changedModelFiles,
    affectedEntryPoints: affectedEntryPoints.sort((a, b) =>
      a.capabilityId.localeCompare(b.capabilityId) || a.surfaceId.localeCompare(b.surfaceId)),
    siblingSurfaces,
    constraintsInScope: constraintsInScope.sort(),
    testsMissing,
    outOfScopeFiles,
    gateRequirements,
    diffSummary: summarizeDiff(input.diff),
  };
}

function deriveGateRequirements(
  model: LoadedSystemModel,
  scope: { capabilities: string[]; flows: string[]; files: string[]; risk: WorkPacket["riskLevel"] },
): ReviewGateRequirement[] {
  return model.policies.reviewGates.map((gate) => {
    const required = reviewGateMatches(gate, scope);
    return {
      gateId: gate.id,
      name: gate.name,
      status: required ? "required_pending" : "not_required",
      reason: required ? "Matched actual diff or packet scope" : "No diff or scope match",
    };
  });
}

function summarizeDiff(diff: DetailedDiff): string {
  if (diff.files.length === 0) return "No changed files";
  const files = diff.files.map((file) =>
    `${file.file} (${file.status}, +${file.insertions}/-${file.deletions})`);
  return `${diff.filesChanged} files changed, +${diff.insertions}/-${diff.deletions}: ${files.join("; ")}`;
}

function isLikelyTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((glob) => globMatches(glob, file));
}

function intersects(a: string[], b: string[]): boolean {
  const bSet = new Set(b);
  return a.some((item) => bSet.has(item));
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
