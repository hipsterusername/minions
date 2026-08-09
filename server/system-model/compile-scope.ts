import type { Capability, Constraint, DecisionMeta, Flow, Risk, Surface } from "../../shared/system-model/index.ts";
import { relatedSystemModelObjects } from "./relations.ts";
import type { LoadedSystemModel } from "./types.ts";

export interface ExpandedScope {
  capabilities: Capability[];
  flows: Flow[];
  surfaces: Surface[];
  constraints: Constraint[];
  decisions: DecisionMeta[];
  risks: Risk[];
}

/** Match objects plus a single typed hop; scope constraints are injected independently of edges. */
export function expandScope(model: LoadedSystemModel, candidateIds: string[]): ExpandedScope {
  const selected = new Set(candidateIds.filter((id) => model.objectsById.has(id)));
  for (const related of relatedSystemModelObjects(model, [...selected])) selected.add(related.object.id);
  return {
    capabilities: selectedOf(model.capabilities, selected),
    flows: selectedOf(model.flows, selected),
    surfaces: selectedOf(model.surfaces, selected),
    constraints: selectedOf(model.constraints, selected),
    decisions: selectedOf(model.decisions, selected),
    risks: selectedOf(model.risks, selected),
  };
}

function selectedOf<T extends { id: string }>(items: T[], selected: Set<string>): T[] {
  return items.filter((item) => selected.has(item.id)).sort((a, b) => a.id.localeCompare(b.id));
}
