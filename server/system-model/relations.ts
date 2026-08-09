import type { SystemModelObject } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel } from "./types.ts";

export interface RelatedSystemModelObject {
  object: SystemModelObject;
  why: string;
}

/** One-hop, typed adjacency plus non-edge constraint scope injection. */
export function relatedSystemModelObjects(model: LoadedSystemModel, sourceIds: string[]): RelatedSystemModelObject[] {
  const sourceSet = new Set(sourceIds);
  const related = new Map<string, RelatedSystemModelObject>();
  const matchedDomains = new Set<string>();
  const add = (id: string, why: string, source?: SystemModelObject) => {
    if (sourceSet.has(id)) return;
    const target = model.objectsById.get(id);
    if (!target || (source && !relationAllowed(source, target, why))) return;
    if (!related.has(id)) related.set(id, { object: target, why });
  };

  for (const sourceId of sourceSet) {
    const source = model.objectsById.get(sourceId);
    if (!source) continue;
    const domain = domainOf(source);
    if (domain) matchedDomains.add(domain);
    if (source.type === "domain") matchedDomains.add(source.id);
    if (source.type === "capability") {
      for (const id of source.dependsOn) add(id, "depends_on", source);
      for (const id of [...source.decisions, ...source.risks]) add(id, relationForId(id), source);
      for (const entry of source.entryPoints) {
        add(entry.surface, "entry_point", source);
        for (const id of entry.flows) add(id, "entry_point", source);
      }
    } else if (source.type === "flow") {
      add(source.primaryCapability, "primary_capability", source);
      for (const id of [...source.decisions, ...source.risks]) add(id, relationForId(id), source);
    } else if (source.type === "constraint") {
      for (const id of source.guards) add(id, "guards", source);
      for (const id of source.evidence) add(id, "evidence", source);
    } else if (source.type === "risk") {
      for (const id of [...source.appliesTo.capabilities, ...source.appliesTo.flows, ...source.appliesTo.surfaces]) {
        add(id, "risk (inverse)", source);
      }
    }
    if (source.type === "capability" || source.type === "flow") {
      for (const bridge of source.bridges) add(bridge.to, `bridge: ${bridge.reason}`);
    }
    addInverseRelations(model, source, add);
  }

  for (const constraint of model.constraints) {
    if (constraint.scope === "global") add(constraint.id, "scope: global");
    else if (constraint.scope === "domain" && matchedDomains.has(constraint.domain)) {
      add(constraint.id, `scope: domain ${constraint.domain}`);
    }
  }
  return [...related.values()].sort((a, b) => a.object.id.localeCompare(b.object.id));
}

function addInverseRelations(
  model: LoadedSystemModel,
  source: SystemModelObject,
  add: (id: string, why: string, source?: SystemModelObject) => void,
): void {
  for (const capability of model.capabilities) {
    if (capability.dependsOn.includes(source.id)) add(capability.id, "depends_on (inverse)", source);
    if (capability.decisions.includes(source.id)) add(capability.id, "decision (inverse)", source);
    if (capability.risks.includes(source.id)) add(capability.id, "risk (inverse)", source);
    if (capability.entryPoints.some((entry) => entry.surface === source.id || entry.flows.includes(source.id))) {
      add(capability.id, "entry_point (inverse)", source);
    }
    if (capability.bridges.some((bridge) => bridge.to === source.id)) add(capability.id, "bridge (inverse)");
  }
  for (const flow of model.flows) {
    if (flow.primaryCapability === source.id) add(flow.id, "implements", source);
    if (flow.decisions.includes(source.id)) add(flow.id, "decision (inverse)", source);
    if (flow.risks.includes(source.id)) add(flow.id, "risk (inverse)", source);
    if (flow.bridges.some((bridge) => bridge.to === source.id)) add(flow.id, "bridge (inverse)");
  }
  for (const constraint of model.constraints) {
    if (constraint.scope === "targeted" && constraint.guards.includes(source.id)) add(constraint.id, "guards (inverse)", source);
    if (constraint.evidence.includes(source.id)) add(constraint.id, "evidence (inverse)", source);
  }
  for (const risk of model.risks) {
    if ([...risk.appliesTo.capabilities, ...risk.appliesTo.flows, ...risk.appliesTo.surfaces].includes(source.id)) {
      add(risk.id, "risk", source);
    }
  }
}

function relationAllowed(source: SystemModelObject, target: SystemModelObject, why: string): boolean {
  const sourceDomain = domainOf(source);
  const targetDomain = domainOf(target);
  if (!sourceDomain || !targetDomain || sourceDomain === targetDomain || why.startsWith("bridge")) return true;
  if ((source.type === "capability" || source.type === "flow") && source.bridges.some((bridge) => bridge.to === target.id)) return true;
  if ((target.type === "capability" || target.type === "flow") && target.bridges.some((bridge) => bridge.to === source.id)) return true;
  return false;
}

function domainOf(object: SystemModelObject): string | undefined {
  return object.type === "capability" || object.type === "flow" || object.type === "constraint" || object.type === "risk"
    ? object.domain : undefined;
}

function relationForId(id: string): string {
  return id.startsWith("decision.") ? "decision" : "risk";
}
