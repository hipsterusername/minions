import type { LoadedSystemModel, ModelValidationError } from "./types.ts";

export function validateLoadedSystemModel(model: LoadedSystemModel): ModelValidationError[] {
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
