import type { SystemGraph, SystemGraphEdge, SystemGraphNode } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel } from "./types.ts";

export function systemModelToGraph(model: LoadedSystemModel): SystemGraph {
  const nodes: SystemGraphNode[] = [
    ...model.domains.map((domain) => node(domain.id, domain.type, domain.name, domain.summary)),
    ...model.capabilities.map((item) => ({
      ...node(item.id, item.type, item.name, item.summary), domain: item.domain, risk: item.risk,
    })),
    ...model.flows.map((item) => ({
      ...node(item.id, item.type, item.name, item.summary), domain: item.domain, risk: item.risk,
    })),
    ...model.constraints.map((item) => ({
      ...node(item.id, item.type, item.statement), domain: item.domain, risk: item.severity,
    })),
    ...model.decisions.map((item) => node(item.id, item.type, item.title, item.summary)),
    ...model.risks.map((item) => ({
      ...node(item.id, item.type, item.summary), domain: item.domain, risk: item.severity,
    })),
    ...model.surfaces.map((item) => ({
      ...node(item.id, item.type, item.name, item.summary),
      ...(item.suggestedFiles.length > 0 ? { suggestedFiles: item.suggestedFiles } : {}),
      ...(item.suggestedTests.length > 0 ? { suggestedTests: item.suggestedTests } : {}),
    })),
  ];
  return { nodes, edges: dedupeEdges(edgesFor(model)) };
}

function node(id: string, type: SystemGraphNode["type"], label: string, summary?: string): SystemGraphNode {
  return { id, type, label, ...(summary ? { summary } : {}), freshness: "unknown" };
}

function edgesFor(model: LoadedSystemModel): SystemGraphEdge[] {
  const edges: SystemGraphEdge[] = [];
  for (const capability of model.capabilities) {
    pushRefs(edges, capability.id, capability.dependsOn, "depends_on");
    pushRefs(edges, capability.id, capability.decisions, "decision");
    pushRefs(edges, capability.id, capability.risks, "risk");
    pushBridges(edges, capability.id, capability.bridges);
    for (const entryPoint of capability.entryPoints) {
      edges.push({
        id: `${capability.id}->entry_point->${entryPoint.surface}`,
        source: capability.id, target: entryPoint.surface, relation: "entry_point",
        files: entryPoint.files, tests: entryPoint.tests,
        ...(entryPoint.summary ? { summary: entryPoint.summary } : {}),
      });
      pushRefs(edges, capability.id, entryPoint.flows, "entry_point");
    }
  }
  for (const flow of model.flows) {
    pushRefs(edges, flow.id, [flow.primaryCapability], "implements");
    pushRefs(edges, flow.id, flow.decisions, "decision");
    pushRefs(edges, flow.id, flow.risks, "risk");
    pushBridges(edges, flow.id, flow.bridges);
  }
  for (const constraint of model.constraints) {
    pushRefs(edges, constraint.id, constraint.guards, "guards");
    pushRefs(edges, constraint.id, constraint.evidence, "evidence");
  }
  for (const risk of model.risks) {
    for (const source of [...risk.appliesTo.capabilities, ...risk.appliesTo.flows]) {
      pushRefs(edges, source, [risk.id], "risk");
    }
  }
  return edges;
}

function pushBridges(edges: SystemGraphEdge[], source: string, bridges: Array<{ to: string; reason: string }>): void {
  for (const bridge of bridges) edges.push({
    id: `${source}->bridge->${bridge.to}`, source, target: bridge.to, relation: "bridge", summary: bridge.reason,
  });
}

function pushRefs(edges: SystemGraphEdge[], source: string, targets: string[], relation: SystemGraphEdge["relation"]): void {
  for (const target of targets) edges.push({ id: `${source}->${relation}->${target}`, source, target, relation });
}

function dedupeEdges(edges: SystemGraphEdge[]): SystemGraphEdge[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()];
}
