import type { Capability, Constraint, DecisionMeta, Flow, Risk, Surface } from "../../shared/system-model/index.ts";
import { relatedSystemModelObjects } from "./relations.ts";
import { globMatches } from "./match.ts";
import type { LoadedSystemModel } from "./types.ts";

export interface ExpandedScope {
  capabilities: Capability[];
  flows: Flow[];
  surfaces: Surface[];
  constraints: Constraint[];
  decisions: DecisionMeta[];
  risks: Risk[];
}

/** Discovery links are not ownership: include primary behavior and applicable safeguards only. */
export function expandScope(model: LoadedSystemModel, candidateIds: string[], taskFiles: string[] = []): ExpandedScope {
  const selected = new Set(candidateIds.filter((id) => model.objectsById.has(id)));
  const seeds = new Set(selected);
  for (const { object, why } of relatedSystemModelObjects(model, [...selected])) {
    if (object.type === "constraint" || why.startsWith("scope:")) continue;
    if (why.startsWith("bridge") || why.startsWith("depends_on")) continue;
    if (object.type === "flow" && !seeds.has(object.primaryCapability)) continue;
    if (object.type === "flow" && taskFiles.length
      && !object.suggestedFiles.some((glob) => taskFiles.some((file) => pathsOverlap(glob, file)))) continue;
    if (object.type === "capability" && why === "entry_point (inverse)" && taskFiles.length
      && !object.entryPoints.some((entry) => seeds.has(entry.surface)
        && entry.files.some((glob) => taskFiles.some((file) => pathsOverlap(glob, file))))) continue;
    selected.add(object.id);
  }
  const behavior = [...model.capabilities, ...model.flows].filter((object) => selected.has(object.id));
  const files = taskFiles.length ? taskFiles : behavior.flatMap((object) => object.suggestedFiles);
  const domains = new Set(behavior.map((object) => object.domain));
  const explicitConstraints = new Set(behavior.flatMap((object) => object.constraints));
  for (const constraint of model.constraints) {
    const fileMatch = constraint.appliesTo.files.some((glob) => files.some((file) => pathsOverlap(glob, file)));
    const scoped = constraint.scope === "global" || (constraint.scope === "domain" && domains.has(constraint.domain));
    if (explicitConstraints.has(constraint.id) || constraint.guards.some((id) => selected.has(id))
      || fileMatch || (scoped && constraint.appliesTo.files.length === 0 && selected.size > 0)) {
      selected.add(constraint.id);
    }
  }
  for (const object of behavior) {
    for (const id of [...object.decisions, ...object.risks]) selected.add(id);
  }
  for (const constraint of model.constraints.filter((object) => selected.has(object.id))) {
    for (const id of constraint.evidence) selected.add(id);
  }
  return {
    capabilities: selectedOf(model.capabilities, selected),
    flows: selectedOf(model.flows, selected),
    surfaces: selectedOf(model.surfaces, selected),
    constraints: selectedOf(model.constraints, selected),
    decisions: selectedOf(model.decisions, selected),
    risks: selectedOf(model.risks, selected),
  };
}

export function pathsOverlap(a: string, b: string): boolean {
  return globMatches(a, b) || globMatches(b, a);
}

function selectedOf<T extends { id: string }>(items: T[], selected: Set<string>): T[] {
  return items.filter((item) => selected.has(item.id)).sort((a, b) => a.id.localeCompare(b.id));
}
