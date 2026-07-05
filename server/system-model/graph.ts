import type { SystemGraph, SystemGraphEdge, SystemGraphNode } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel } from "./types.ts";

export function systemModelToGraph(model: LoadedSystemModel): SystemGraph {
  const nodes: SystemGraphNode[] = [
    ...model.capabilities.map((c) => ({
      id: c.id,
      type: c.type,
      label: c.name,
      summary: c.summary,
      risk: c.risk,
      freshness: "unknown" as const,
    })),
    ...model.flows.map((f) => ({
      id: f.id,
      type: f.type,
      label: f.name,
      summary: f.summary,
      risk: f.risk,
      freshness: "unknown" as const,
    })),
    ...model.constraints.map((c) => ({
      id: c.id,
      type: c.type,
      label: c.statement,
      risk: c.severity,
      freshness: "unknown" as const,
    })),
    ...model.decisions.map((d) => ({
      id: d.id,
      type: d.type,
      label: d.title,
      summary: d.summary,
      freshness: "unknown" as const,
    })),
    ...model.risks.map((r) => ({
      id: r.id,
      type: r.type,
      label: r.summary,
      risk: r.severity,
      freshness: "unknown" as const,
    })),
  ];
  return { nodes, edges: dedupeEdges(edgesFor(model)) };
}

function edgesFor(model: LoadedSystemModel): SystemGraphEdge[] {
  const edges: SystemGraphEdge[] = [];
  for (const capability of model.capabilities) {
    pushRefs(edges, capability.id, capability.linkedFlows, "linked_flow");
    pushRefs(edges, capability.id, capability.constraints, "constraint");
    pushRefs(edges, capability.id, capability.decisions, "decision");
    pushRefs(edges, capability.id, capability.risks, "risk");
  }
  for (const flow of model.flows) {
    pushRefs(edges, flow.id, flow.capabilities, "capability");
    pushRefs(edges, flow.id, flow.constraints, "constraint");
    pushRefs(edges, flow.id, flow.decisions, "decision");
    pushRefs(edges, flow.id, flow.risks, "risk");
  }
  for (const constraint of model.constraints) {
    pushRefs(edges, constraint.id, constraint.appliesTo.capabilities, "capability");
    pushRefs(edges, constraint.id, constraint.appliesTo.flows, "linked_flow");
    pushRefs(edges, constraint.id, constraint.evidence, "evidence");
  }
  for (const risk of model.risks) {
    pushRefs(edges, risk.id, risk.appliesTo.capabilities, "capability");
    pushRefs(edges, risk.id, risk.appliesTo.flows, "linked_flow");
  }
  return edges;
}

function pushRefs(
  edges: SystemGraphEdge[],
  source: string,
  targets: string[],
  relation: SystemGraphEdge["relation"],
): void {
  for (const target of targets) {
    edges.push({ id: `${source}->${relation}->${target}`, source, target, relation });
  }
}

function dedupeEdges(edges: SystemGraphEdge[]): SystemGraphEdge[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()];
}
