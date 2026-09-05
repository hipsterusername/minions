import type { ReviewGate, RiskLevel } from "../../shared/system-model/index.ts";
import { globMatches } from "./match.ts";

export function reviewGateMatches(gate: ReviewGate, scope: {
  files: string[]; capabilities: string[]; flows: string[]; risk: RiskLevel;
}): boolean {
  return scope.files.some((file) => gate.requiredWhen.files.some((glob) => globMatches(glob, file)))
    || gate.requiredWhen.capabilities.some((id) => scope.capabilities.includes(id))
    || gate.requiredWhen.flows.some((id) => scope.flows.includes(id))
    || gate.requiredWhen.risk.includes(scope.risk);
}
