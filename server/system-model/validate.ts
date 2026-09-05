import type { Constraint, SystemModelObject } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel, ModelValidationError } from "./types.ts";
import { globMatches } from "./match.ts";
import { validateFileAnchors } from "./file-anchors.ts";

export const OVERBREADTH_THRESHOLD = 0.4;

export function computeOverbreadth(model: LoadedSystemModel, trackedFiles: string[]): Array<{ objectId: string; kind: "gate" | "constraint"; coverage: number }> {
  if (trackedFiles.length === 0) return [];
  const entries: Array<{ objectId: string; kind: "gate" | "constraint"; globs: string[] }> = [
    ...model.policies.reviewGates.map((gate) => ({ objectId: gate.id, kind: "gate" as const, globs: gate.requiredWhen.files })),
    ...model.constraints.filter((constraint) => constraint.appliesTo.files.length > 0)
      .map((constraint) => ({ objectId: constraint.id, kind: "constraint" as const, globs: constraint.appliesTo.files })),
  ];
  return entries.flatMap((entry) => {
    const matched = trackedFiles.filter((file) => entry.globs.some((glob) => globMatches(glob, file))).length;
    const coverage = matched / trackedFiles.length;
    return coverage > OVERBREADTH_THRESHOLD ? [{ objectId: entry.objectId, kind: entry.kind, coverage }] : [];
  });
}

export function validateLoadedSystemModel(model: LoadedSystemModel, trackedFiles?: string[]): ModelValidationError[] {
  const errors: ModelValidationError[] = [];
  if (trackedFiles) errors.push(...validateFileAnchors(model, trackedFiles));
  for (const object of model.objectsById.values()) {
    if (hasDomain(object)) checkRefs(errors, model, object.id, "domain", [object.domain], "domain.");
  }
  for (const capability of model.capabilities) {
    checkRefs(errors, model, capability.id, "dependsOn", capability.dependsOn, "capability.");
    checkRefs(errors, model, capability.id, "constraints", capability.constraints, "constraint.");
    checkRefs(errors, model, capability.id, "decisions", capability.decisions, "decision.");
    checkRefs(errors, model, capability.id, "risks", capability.risks, "risk.");
    validateBridges(errors, model, capability);
    for (const dependency of capability.dependsOn) validateCrossDomain(errors, model, capability, dependency, "depends_on");
    for (const risk of capability.risks) validateCrossDomain(errors, model, capability, risk, "risk");
    const seenSurfaces = new Set<string>();
    for (const entryPoint of capability.entryPoints) {
      checkRefs(errors, model, capability.id, "entryPoints.surface", [entryPoint.surface], "surface.");
      checkRefs(errors, model, capability.id, "entryPoints.flows", entryPoint.flows, "flow.");
      for (const flow of entryPoint.flows) validateCrossDomain(errors, model, capability, flow, "entry_point");
      if (seenSurfaces.has(entryPoint.surface)) errors.push({ file: capability.id, path: "entryPoints", message: `Duplicate entry point for ${entryPoint.surface}` });
      seenSurfaces.add(entryPoint.surface);
    }
    validateConstraintRefs(errors, model, capability.id, capability.constraints);
  }
  for (const flow of model.flows) {
    checkRefs(errors, model, flow.id, "primaryCapability", [flow.primaryCapability], "capability.");
    checkRefs(errors, model, flow.id, "constraints", flow.constraints, "constraint.");
    checkRefs(errors, model, flow.id, "decisions", flow.decisions, "decision.");
    checkRefs(errors, model, flow.id, "risks", flow.risks, "risk.");
    validateBridges(errors, model, flow);
    validateCrossDomain(errors, model, flow, flow.primaryCapability, "primary_capability");
    for (const risk of flow.risks) validateCrossDomain(errors, model, flow, risk, "risk");
    validateConstraintRefs(errors, model, flow.id, flow.constraints);
  }
  for (const constraint of model.constraints) {
    checkRefs(errors, model, constraint.id, "guards", constraint.guards, ["capability.", "flow."]);
    checkRefs(errors, model, constraint.id, "appliesTo.capabilities", constraint.appliesTo.capabilities, "capability.");
    checkRefs(errors, model, constraint.id, "appliesTo.flows", constraint.appliesTo.flows, "flow.");
    checkRefs(errors, model, constraint.id, "appliesTo.surfaces", constraint.appliesTo.surfaces, "surface.");
    checkRefs(errors, model, constraint.id, "evidence", constraint.evidence, "decision.");
    validateConstraintScope(errors, constraint);
    for (const guard of constraint.guards) validateGuardDomain(errors, model, constraint, guard);
    if (constraint.reviewGate && !model.reviewGatesById.has(constraint.reviewGate)) {
      errors.push({ file: constraint.id, path: "reviewGate", message: `Unknown review gate ${constraint.reviewGate}` });
    }
  }
  for (const risk of model.risks) {
    checkRefs(errors, model, risk.id, "appliesTo.capabilities", risk.appliesTo.capabilities, "capability.");
    checkRefs(errors, model, risk.id, "appliesTo.flows", risk.appliesTo.flows, "flow.");
    checkRefs(errors, model, risk.id, "appliesTo.surfaces", risk.appliesTo.surfaces, "surface.");
    for (const sourceId of [...risk.appliesTo.capabilities, ...risk.appliesTo.flows]) {
      const source = model.objectsById.get(sourceId);
      if (source?.type === "capability" || source?.type === "flow") validateCrossDomain(errors, model, source, risk.id, "risk");
    }
  }
  for (const issue of computeOverbreadth(model, trackedFiles ?? [])) {
    errors.push({
      file: issue.objectId,
      path: issue.kind === "gate" ? "requiredWhen.files" : "appliesTo.files",
      message: `Applicability globs cover ${(issue.coverage * 100).toFixed(1)}% of tracked files`,
      severity: "warning",
    } as ModelValidationError);
  }
  return errors;
}

function validateConstraintScope(errors: ModelValidationError[], constraint: Constraint): void {
  if (constraint.scope === "targeted" && constraint.guards.length === 0) {
    errors.push({ file: constraint.id, path: "guards", message: `Targeted constraint ${constraint.id} must declare at least one guard` });
  }
  if (constraint.scope !== "targeted" && constraint.guards.length > 0) {
    errors.push({ file: constraint.id, path: "guards", message: `${capitalize(constraint.scope)} constraint ${constraint.id} must not declare guards` });
  }
  if (constraint.scope !== "targeted") {
    const explicit = [...constraint.appliesTo.capabilities, ...constraint.appliesTo.flows, ...constraint.appliesTo.surfaces];
    if (explicit.length > 0) errors.push({
      file: constraint.id,
      path: "appliesTo",
      message: `${capitalize(constraint.scope)} constraint ${constraint.id} must not declare explicit applies_to object links`,
    });
  }
}

function validateConstraintRefs(errors: ModelValidationError[], model: LoadedSystemModel, ownerId: string, refs: string[]): void {
  for (const ref of refs) {
    const constraint = model.objectsById.get(ref);
    if (constraint?.type === "constraint" && constraint.scope !== "targeted") errors.push({
      file: ownerId,
      path: "constraints",
      message: `${capitalize(constraint.scope)} constraint ${ref} must not be explicitly referenced by ${ownerId}`,
    });
  }
}

function validateBridges(
  errors: ModelValidationError[],
  model: LoadedSystemModel,
  source: Extract<SystemModelObject, { type: "capability" | "flow" }>,
): void {
  for (const bridge of source.bridges) checkRefs(errors, model, source.id, "bridges.to", [bridge.to], ["capability.", "flow.", "constraint.", "risk."]);
}

function validateCrossDomain(
  errors: ModelValidationError[],
  model: LoadedSystemModel,
  source: Extract<SystemModelObject, { type: "capability" | "flow" }>,
  targetId: string,
  relation: string,
): void {
  const target = model.objectsById.get(targetId);
  if (!target || !hasDomain(target) || target.domain === source.domain) return;
  if (!source.bridges.some((bridge) => bridge.to === targetId)) errors.push({
    file: source.id,
    path: relation === "depends_on" ? "dependsOn"
      : relation === "primary_capability" ? "primaryCapability"
        : relation === "entry_point" ? "entryPoints.flows" : "risks",
    message: `Cross-domain ${relation} reference from ${source.id} to ${targetId} requires a bridge to ${targetId}`,
  });
}

function validateGuardDomain(errors: ModelValidationError[], model: LoadedSystemModel, constraint: Constraint, guardId: string): void {
  const guard = model.objectsById.get(guardId);
  if (!guard || (guard.type !== "capability" && guard.type !== "flow") || guard.domain === constraint.domain) return;
  if (!guard.bridges.some((bridge) => bridge.to === constraint.id)) errors.push({
    file: constraint.id,
    path: "guards",
    message: `Cross-domain guards reference from ${constraint.id} to ${guardId} requires a bridge from ${guardId} to ${constraint.id}`,
  });
}

function checkRefs(
  out: ModelValidationError[], model: LoadedSystemModel, file: string, field: string,
  refs: string[], prefixes: string | string[],
): void {
  const allowed = Array.isArray(prefixes) ? prefixes : [prefixes];
  for (const ref of refs) if (!allowed.some((prefix) => ref.startsWith(prefix)) || !model.objectsById.has(ref)) {
    out.push({ file, path: field, message: `Unknown reference ${ref}` });
  }
}

function hasDomain(object: SystemModelObject): object is Extract<SystemModelObject, { type: "capability" | "flow" | "constraint" | "risk" }> {
  return object.type === "capability" || object.type === "flow" || object.type === "constraint" || object.type === "risk";
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}
