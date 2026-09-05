import type { SystemModelObject } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel } from "./types.ts";

export const DISCOVERY_RELATIONSHIPS = ["depends_on", "decision", "risk", "constraint", "entry_point",
  "primary_capability", "guards", "evidence", "bridge", "domain", "applies_to"] as const;
export type DiscoveryRelationship = typeof DISCOVERY_RELATIONSHIPS[number];
export interface DiscoveryEdge { source: string; target: string; relation: DiscoveryRelationship; field: string; reason?: string }

/** Declared object references only. Packet scope and global applicability are separate. */
export function discoveryEdges(model: LoadedSystemModel): DiscoveryEdge[] {
  const edges: DiscoveryEdge[] = [];
  for (const object of model.objectsById.values()) {
    const add = (target: string, relation: DiscoveryRelationship, field: string, reason?: string) => {
      const destination = model.objectsById.get(target);
      if (destination && allowed(object, destination, relation)) edges.push({ source: object.id, target, relation, field, ...(reason ? { reason } : {}) });
    };
    const refs = (values: string[], relation: DiscoveryRelationship, field: string) =>
      values.forEach((id, index) => add(id, relation, `${field}[${index}]`));
    if ("domain" in object) add(object.domain, "domain", "domain");
    if (object.type === "capability" || object.type === "flow") {
      refs(object.constraints, "constraint", "constraints"); refs(object.decisions, "decision", "decisions"); refs(object.risks, "risk", "risks");
      object.bridges.forEach((bridge, index) => add(bridge.to, "bridge", `bridges[${index}]`, bridge.reason));
      if (object.type === "capability") {
        refs(object.dependsOn, "depends_on", "dependsOn");
        object.entryPoints.forEach((entry, index) => {
          add(entry.surface, "entry_point", `entryPoints[${index}].surface`); refs(entry.flows, "entry_point", `entryPoints[${index}].flows`);
        });
      } else add(object.primaryCapability, "primary_capability", "primaryCapability");
    }
    if (object.type === "constraint" || object.type === "decision") refs(object.evidence, "evidence", "evidence");
    if (object.type === "constraint") refs(object.guards, "guards", "guards");
    if (object.type === "constraint" || object.type === "risk") {
      refs(object.appliesTo.capabilities, "applies_to", "appliesTo.capabilities");
      refs(object.appliesTo.flows, "applies_to", "appliesTo.flows"); refs(object.appliesTo.surfaces, "applies_to", "appliesTo.surfaces");
    }
  }
  return edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
    || a.relation.localeCompare(b.relation) || a.field.localeCompare(b.field));
}

function allowed(source: SystemModelObject, target: SystemModelObject, relation: DiscoveryRelationship): boolean {
  const sourceDomain = "domain" in source ? source.domain : undefined;
  const targetDomain = "domain" in target ? target.domain : undefined;
  if (!sourceDomain || !targetDomain || sourceDomain === targetDomain || relation === "bridge") return true;
  return hasBridge(source, target.id) || hasBridge(target, source.id);
}
function hasBridge(object: SystemModelObject, id: string): boolean {
  return (object.type === "capability" || object.type === "flow") && object.bridges.some((bridge) => bridge.to === id);
}
