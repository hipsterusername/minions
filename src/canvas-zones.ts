import type { LeaderData } from "./nodes/leader/types.ts";
import { selectWorkItemPresentation } from "../shared/work-item-lifecycle.ts";
import { partitionDashboardQuestions } from "./nodes/render/dashboard-questions.ts";
import type { CanvasNode } from "./types.ts";
import { SKILL_ICON_LIBRARY, SKILL_ICON_PREFIX } from "./skills/icon-library.ts";

const workspaceIcons = new Set(SKILL_ICON_LIBRARY.map(icon => `${SKILL_ICON_PREFIX}${icon.name}`));
export function isWorkspaceIcon(value: unknown): value is string { return typeof value === "string" && workspaceIcons.has(value); }

// Metadata nodes participate in the workspace's existing atomic canvas save.
// They have no renderer, ports, execution identity, or spatial footprint.
export const ZONE_NODE_TYPE = "canvas-zone";
export const GLOBAL_WORKSPACE_ID = "__canvas-global-workspace__";
// Keep the existing metadata type and leaderIds readable for saved Zones.
export interface ZoneData { version: 1; name: string; icon?: string; leaderIds: string[]; nodeIds?: string[]; activeWorkspaceId?: string }
export function activeWorkspaceId(nodes: CanvasNode[]): string {
  const id = (nodes.find(n => n.id === GLOBAL_WORKSPACE_ID)?.data as ZoneData | undefined)?.activeWorkspaceId;
  return id && readZones(nodes).some(zone => zone.id === id) ? id : GLOBAL_WORKSPACE_ID;
}
export type CanvasZone = CanvasNode<ZoneData>;

export function readZones(nodes: CanvasNode[]): CanvasZone[] {
  const content = new Map(nodes.filter(n => n.type !== ZONE_NODE_TYPE).map(n => [n.id, n]));
  const assigned = new Set<string>();
  return nodes.flatMap(node => {
    if (node.type !== ZONE_NODE_TYPE || node.id === GLOBAL_WORKSPACE_ID) return [];
    const data = node.data as Partial<ZoneData> | null;
    if (data?.version !== 1 || typeof data.name !== "string" || !Array.isArray(data.leaderIds)) return [];
    const nodeIds = [...(Array.isArray(data.nodeIds) ? data.nodeIds : []), ...data.leaderIds].filter(id => {
      if (typeof id !== "string" || !content.has(id) || assigned.has(id)) return false;
      assigned.add(id); return true;
    });
    return [{ ...node, data: { version: 1 as const, name: data.name, ...(isWorkspaceIcon(data.icon) ? { icon: data.icon } : {}), nodeIds, leaderIds: nodeIds.filter(id => content.get(id)?.type === "leader") } }];
  });
}

export function createZone(id: string, name: string): CanvasZone {
  return { id, type: ZONE_NODE_TYPE, position: { x: 0, y: 0 }, size: { width: 0, height: 0 },
    data: { version: 1, name: name.trim().slice(0, 48), leaderIds: [] } };
}

export function clusterIds(nodes: CanvasNode[], leaderIds: readonly string[]): Set<string> {
  const leaders = new Set(leaderIds);
  return new Set(nodes.filter(node => {
    if (node.type === "leader") return leaders.has(node.id);
    const owner = (node.data as { leaderId?: string } | null)?.leaderId;
    return (node.type === "minion" || node.type === "render") && !!owner && leaders.has(owner);
  }).map(node => node.id));
}

export function zoneMembership(nodes: CanvasNode[]): Map<string, CanvasZone> {
  const result = new Map<string, CanvasZone>();
  const zones = readZones(nodes);
  const leaders = new Set(nodes.filter(n => n.type === "leader").map(n => n.id));
  for (const zone of zones) for (const id of zone.data.nodeIds ?? zone.data.leaderIds) result.set(id, zone);
  // Owned output always follows its leader, including output arriving while another workspace is active.
  for (const node of nodes) {
    const owner = (node.data as { leaderId?: string } | null)?.leaderId;
    if ((node.type === "minion" || node.type === "render") && owner && leaders.has(owner)) {
      const workspace = result.get(owner);
      if (workspace) result.set(node.id, workspace); else result.delete(node.id);
    }
  }
  return result;
}

export function readWorkspaces(nodes: CanvasNode[]): CanvasZone[] {
  const membership = zoneMembership(nodes);
  const globalNodes = nodes.filter(n => n.type !== ZONE_NODE_TYPE && !membership.has(n.id));
  return [{ ...createZone(GLOBAL_WORKSPACE_ID, "Global"), data: { version: 1, name: "Global",
    leaderIds: globalNodes.filter(n => n.type === "leader").map(n => n.id), nodeIds: globalNodes.map(n => n.id) } }, ...readZones(nodes)];
}

export function visibleZoneNodes(nodes: CanvasNode[], workspaceId = GLOBAL_WORKSPACE_ID): CanvasNode[] {
  const membership = zoneMembership(nodes);
  return nodes.filter(node => node.type !== ZONE_NODE_TYPE && (membership.get(node.id)?.id ?? GLOBAL_WORKSPACE_ID) === workspaceId);
}

export function moveToZone(zones: CanvasZone[], ids: readonly string[], target: string | null): CanvasZone[] {
  if (target !== null && target !== GLOBAL_WORKSPACE_ID && !zones.some(zone => zone.id === target)) return zones;
  const moved = new Set(ids);
  return zones.filter(zone => zone.id !== GLOBAL_WORKSPACE_ID).map(zone => ({ ...zone, data: { ...zone.data,
    nodeIds: [...(zone.data.nodeIds ?? zone.data.leaderIds).filter(id => !moved.has(id)), ...(zone.id === target ? [...moved] : [])],
    leaderIds: [...zone.data.leaderIds.filter(id => !moved.has(id)), ...(zone.id === target ? [...moved] : [])],
  } }));
}

/** Include owned output and spatial group contents when explicitly transferring content. */
export function workspaceTransferIds(nodes: CanvasNode[], ids: readonly string[]): string[] {
  const selected = new Set(ids);
  for (const group of nodes.filter(n => selected.has(n.id) && n.type === "context-group")) {
    for (const node of nodes) if (node.type !== ZONE_NODE_TYPE && node.position.x >= group.position.x && node.position.y >= group.position.y &&
      node.position.x + node.size.width <= group.position.x + group.size.width && node.position.y + node.size.height <= group.position.y + group.size.height) selected.add(node.id);
  }
  for (const node of nodes) {
    const owner = (node.data as { leaderId?: string } | null)?.leaderId;
    if ((node.type === "minion" || node.type === "render") && owner && selected.has(node.id)) selected.add(owner);
  }
  for (const id of clusterIds(nodes, [...selected])) selected.add(id);
  return [...selected].filter(id => nodes.some(n => n.id === id && n.type !== ZONE_NODE_TYPE));
}

export function zoneLeaderLabel(node: CanvasNode): string {
  const data = node.data as { taskName?: string; name?: string };
  return data.taskName?.trim() || data.name?.trim() || "Untitled leader";
}

export function zoneLeaderState(node: CanvasNode): string {
  const data = node.data as Partial<LeaderData>;
  if (data.approvalPending || partitionDashboardQuestions(data.renderState?.components ?? [], new Map()).questions.length) return "Needs input";
  if (data.workItemSnapshot) {
    const item = data.workItemSnapshot;
    const presentation = selectWorkItemPresentation(item.lifecycle, { waitKind: item.waitKind });
    if (item.lifecycle.runtimeState === "waiting" && item.waitKind === "decision") return "Needs input";
    return presentation.label;
  }
  if (data.status === "running" || data.status === "creating") return "Working";
  if (data.status === "error") return "Error";
  if (data.status === "completed") return "Done";
  if (data.status === "stopped") return "Stopped";
  return "Idle";
}

export function zoneSummary(nodes: CanvasNode[]): string {
  const states = nodes.map(zoneLeaderState);
  const count = (...values: string[]) => states.filter(s => values.includes(s)).length;
  return [count("Needs input") && `${count("Needs input")} needs input`, count("Error") && `${count("Error")} errors`,
    count("Working", "Starting") && `${count("Working", "Starting")} working`,
    count("Ready for review") && `${count("Ready for review")} ready for review`,
    count("Waiting", "Waiting for files") && `${count("Waiting", "Waiting for files")} waiting`,
    count("Merge conflict", "Interrupted") && `${count("Merge conflict", "Interrupted")} needs attention`].filter(Boolean).join(" · ") ||
    (nodes.length === 0 ? "Empty workspace" : states.every(s => ["Done", "Reviewed", "Archived"].includes(s)) ? "All done" : `${nodes.length} leader${nodes.length === 1 ? "" : "s"}`);
}

export function zoneConnectionLabels(edges: { sourceNodeId: string; targetNodeId: string }[], membership: Map<string, CanvasZone>): Map<string, string> {
  const names = new Map<string, Set<string>>();
  for (const edge of edges) for (const [visible, hidden] of [[edge.sourceNodeId, edge.targetNodeId], [edge.targetNodeId, edge.sourceNodeId]]) {
    const zone = membership.get(hidden!);
    if (!zone || membership.has(visible!)) continue;
    const set = names.get(visible!) ?? new Set<string>(); set.add(zone.data.name); names.set(visible!, set);
  }
  return new Map([...names].map(([id, zones]) => [id, `Connected to ${[...zones].join(", ")}`]));
}
