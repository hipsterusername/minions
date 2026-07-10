import type { LoadedSystemModel, ModelValidationError } from "./types.ts";
import { globMatches } from "./match.ts";

export const OVERBREADTH_THRESHOLD = 0.4;

export function computeOverbreadth(model: LoadedSystemModel, trackedFiles: string[]): Array<{ objectId: string; kind: "gate" | "constraint"; coverage: number }> {
  if (trackedFiles.length === 0) return [];
  const entries: Array<{ objectId: string; kind: "gate" | "constraint"; globs: string[] }> = [
    ...model.policies.reviewGates.map((gate) => ({
      objectId: gate.id,
      kind: "gate" as const,
      globs: gate.requiredWhen.files,
    })),
    ...model.constraints
      .filter((constraint) => constraint.appliesTo.files.length > 0)
      .map((constraint) => ({
        objectId: constraint.id,
        kind: "constraint" as const,
        globs: constraint.appliesTo.files,
      })),
  ];

  return entries.flatMap((entry) => {
    const matched = trackedFiles.filter((file) => entry.globs.some((glob) => globMatches(glob, file))).length;
    const coverage = matched / trackedFiles.length;
    return coverage > OVERBREADTH_THRESHOLD ? [{ objectId: entry.objectId, kind: entry.kind, coverage }] : [];
  });
}

export function validateLoadedSystemModel(model: LoadedSystemModel, trackedFiles: string[] = []): ModelValidationError[] {
  const errors: ModelValidationError[] = [];
  for (const capability of model.capabilities) {
    checkRefs(errors, capability.id, "linkedFlows", capability.linkedFlows, "flow.");
    checkRefs(errors, capability.id, "constraints", capability.constraints, "constraint.");
    checkRefs(errors, capability.id, "decisions", capability.decisions, "decision.");
    checkRefs(errors, capability.id, "risks", capability.risks, "risk.");
  }
  for (const flow of model.flows) {
    checkRefs(errors, flow.id, "capabilities", flow.capabilities, "capability.");
    checkRefs(errors, flow.id, "constraints", flow.constraints, "constraint.");
    checkRefs(errors, flow.id, "decisions", flow.decisions, "decision.");
    checkRefs(errors, flow.id, "risks", flow.risks, "risk.");
  }
  for (const constraint of model.constraints) {
    checkRefs(errors, constraint.id, "appliesTo.capabilities", constraint.appliesTo.capabilities, "capability.");
    checkRefs(errors, constraint.id, "appliesTo.flows", constraint.appliesTo.flows, "flow.");
    checkRefs(errors, constraint.id, "evidence", constraint.evidence, "decision.");
    if (constraint.reviewGate && !model.reviewGatesById.has(constraint.reviewGate)) {
      errors.push({
        file: constraint.id,
        path: "reviewGate",
        message: `Unknown review gate ${constraint.reviewGate}`,
      });
    }
  }
  for (const risk of model.risks) {
    checkRefs(errors, risk.id, "appliesTo.capabilities", risk.appliesTo.capabilities, "capability.");
    checkRefs(errors, risk.id, "appliesTo.flows", risk.appliesTo.flows, "flow.");
  }
  for (const issue of computeOverbreadth(model, trackedFiles)) {
    const path = issue.kind === "gate" ? "requiredWhen.files" : "appliesTo.files";
    errors.push({
      file: issue.objectId,
      path,
      message: `Applicability globs cover ${(issue.coverage * 100).toFixed(1)}% of tracked files`,
      severity: "warning",
    } as ModelValidationError);
  }
  return errors;

  function checkRefs(
    out: ModelValidationError[],
    file: string,
    field: string,
    refs: string[],
    prefix: string,
  ): void {
    for (const ref of refs) {
      if (!ref.startsWith(prefix) || !model.objectsById.has(ref)) {
        out.push({ file, path: field, message: `Unknown reference ${ref}` });
      }
    }
  }
}
