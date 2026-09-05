import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./types.ts";
import { canvasReducer } from "./canvas-state.ts";
import { clusterIds, createZone, moveToZone, readZones, visibleZoneNodes, zoneMembership, zoneSummary, zoneLeaderState, zoneConnectionLabels, activeWorkspaceId, GLOBAL_WORKSPACE_ID, readWorkspaces, workspaceTransferIds } from "./canvas-zones.ts";
import { toPersistableNodes } from "./use-autosave.ts";

const node = (id: string, type = "leader", data: unknown = {}, x = 0, y = 0): CanvasNode =>
  ({ id, type, data, position: { x, y }, size: { width: 100, height: 100 } });
const a = node("a", "leader", { sessionKey: "session-a", status: "running" });
const b = node("b", "leader", {}, 200, 0);
const minion = node("m", "minion", { leaderId: "a" }, 0, 200);
const zone = { ...createZone("z", "Release"), data: { version: 1 as const, name: "Release", leaderIds: ["a"] } };

describe("canvas zone persistence and visibility", () => {
  it("preserves library icons through membership changes and saved canvas reloads, with defaults for invalid icons", () => {
    const custom = { ...zone, data: { ...zone.data, icon: "minions:rocket" } };
    const moved = canvasReducer([a, b, custom], { type: "UPDATE_ZONES", zones: moveToZone([custom], ["b"], "z"), moves: [] });
    const loaded: CanvasNode[] = JSON.parse(JSON.stringify(toPersistableNodes(moved)));
    expect(readZones(loaded)[0]?.data.icon).toBe("minions:rocket");
    expect(readZones(loaded)[0]?.data.nodeIds).toEqual(["a", "b"]);
    for (const icon of [undefined, 42, "minions:missing", "https://example.com/icon.svg"]) {
      expect(readZones([{ ...custom, data: { ...custom.data, icon } }])[0]?.data.icon).toBeUndefined();
    }
  });
  it("round trips membership through canvas persistence without stripping session identity", () => {
    const nodes = [a, minion, b, zone];
    const loaded: CanvasNode[] = JSON.parse(JSON.stringify(toPersistableNodes(nodes)));
    expect(readZones(loaded)[0]?.data.leaderIds).toEqual(["a"]);
    expect(visibleZoneNodes(loaded).map(n => n.id)).toEqual(["b"]);
    expect(visibleZoneNodes(loaded, "z").map(n => n.id)).toEqual(["a", "m"]);
    expect(loaded[0]?.data).toEqual(a.data);
    expect(readZones(loaded)).toHaveLength(1);
  });
  it("fails open for malformed metadata, missing leaders and duplicate membership", () => {
    const broken = { ...zone, data: { name: "broken", leaderIds: ["b"] } };
    expect(zoneMembership([a, b, broken]).size).toBe(0);
    const second = { ...zone, id: "z2", data: { ...zone.data, leaderIds: ["a", "missing", "b", "b"] } };
    expect(readZones([a, b, zone, second]).map(z => z.data.leaderIds)).toEqual([["a"], ["b"]]);
  });
  it("new owned minions follow an already parked leader, but unrelated nodes do not", () => {
    const other = node("other", "minion", { leaderId: "b" });
    expect([...clusterIds([a, b, minion, other], ["a"])]).toEqual(["a", "m"]);
    expect(visibleZoneNodes([a, b, minion, other, zone]).map(n => n.id)).toEqual(["b", "other"]);
  });
  it("transfers membership exclusively and retains an empty zone after retrieval", () => {
    const next = moveToZone([zone, createZone("z2", "Ideas")], ["a"], "z2");
    expect(next.map(z => z.data.leaderIds)).toEqual([[], ["a"]]);
    expect(moveToZone(next, ["a"], null).map(z => z.data.leaderIds)).toEqual([[], []]);
    expect(moveToZone(next, ["a"], "missing")).toBe(next);
  });
  it("commits layout and membership without replacing concurrent live data", () => {
    const live = { ...a, data: { status: "completed", messages: ["new update"] } };
    const next = canvasReducer([live, minion, b, zone], { type: "UPDATE_ZONES", zones: moveToZone([zone], ["a"], null),
      moves: [{ id: "a", position: { x: 300, y: 400 } }] });
    expect(next.find(n => n.id === "a")?.data).toBe(live.data);
    expect(next.find(n => n.id === "a")?.position).toEqual({ x: 300, y: 400 });
    expect(next.find(n => n.id === "m")).toBe(minion);
  });
  it("keeps cross-zone connections discoverable without changing the graph", () => {
    const edges = [{ sourceNodeId: "a", targetNodeId: "b" }];
    expect(zoneConnectionLabels(edges, zoneMembership([a, b, zone])).get("b")).toBe("Connected to Release");
    expect(edges).toHaveLength(1);
  });
  it("shows pending nested dashboard questions and stops counting submitted forms", () => {
    const form = { id: "q", type: "form", fields: [] };
    const pending = node("p", "leader", { renderState: { components: [{ id: "s", type: "section", components: [form] }] } });
    expect(zoneSummary([pending, a])).toBe("1 needs input · 1 working");
    expect(zoneLeaderState(node("p", "leader", { renderState: { components: [{ ...form, submittedAnswers: {} }] } }))).toBe("Idle");
  });
});


describe("workspace canvases", () => {
  it("persists the active workspace and all content types alongside legacy Zone memberships", () => {
    let nodes = canvasReducer([a, minion, b, zone], { type: "SET_ACTIVE_WORKSPACE", id: "z" });
    nodes = canvasReducer(nodes, { type: "ADD_NODE", node: node("note", "note") });
    const loaded: CanvasNode[] = JSON.parse(JSON.stringify(toPersistableNodes(nodes)));
    expect(activeWorkspaceId(loaded)).toBe("z");
    expect(visibleZoneNodes(loaded, "z").map(n => n.id)).toEqual(["a", "m", "note"]);
    expect(visibleZoneNodes(loaded).map(n => n.id)).toEqual(["b"]);
    expect(readWorkspaces(loaded).map(w => w.data.name)).toEqual(["Global", "Release"]);
  });
  it("new owned output follows its leader even when another workspace is active", () => {
    let nodes = canvasReducer([a, b, zone, createZone("ideas", "Ideas")], { type: "SET_ACTIVE_WORKSPACE", id: "ideas" });
    nodes = canvasReducer(nodes, { type: "ADD_NODE", node: minion });
    nodes = canvasReducer(nodes, { type: "ADD_NODE", node: node("render", "render", { leaderId: "b" }) });
    expect(visibleZoneNodes(nodes, "ideas")).toEqual([]);
    expect(visibleZoneNodes(nodes, "z").map(n => n.id)).toEqual(["a", "m"]);
    expect(visibleZoneNodes(nodes).map(n => n.id)).toEqual(["b", "render"]);
  });
  it("Global is always available, cannot be removed or renamed, and is the fallback for a missing workspace", () => {
    let nodes = canvasReducer([a, zone], { type: "SET_ACTIVE_WORKSPACE", id: "z" });
    nodes = canvasReducer(nodes, { type: "REMOVE_NODES", ids: [GLOBAL_WORKSPACE_ID, "z"] });
    expect(activeWorkspaceId(nodes)).toBe(GLOBAL_WORKSPACE_ID);
    expect(nodes.some(n => n.id === GLOBAL_WORKSPACE_ID)).toBe(true);
    nodes = canvasReducer(nodes, { type: "REMOVE_NODE", id: GLOBAL_WORKSPACE_ID });
    nodes = canvasReducer(nodes, { type: "UPDATE_NODE_DATA", id: GLOBAL_WORKSPACE_ID, data: { name: "Other" } });
    expect(readWorkspaces(nodes)[0]?.data.name).toBe("Global");
    expect(visibleZoneNodes(nodes).map(n => n.id)).toEqual(["a"]);
    expect(readWorkspaces([])[0]?.data.name).toBe("Global");
  });
  it("transfers contained group nodes and owned output together", () => {
    const group = { ...node("group", "context-group"), size: { width: 1000, height: 1000 } };
    expect(workspaceTransferIds([group, a, minion, b], ["group"])).toEqual(["group", "a", "m", "b"]);
    expect(workspaceTransferIds([a, minion, b], ["m"])).toEqual(["m", "a"]);
  });
  it("includes Global in cross-workspace connection hints", () => {
    const global = readWorkspaces([a, b, zone])[0]!;
    expect(zoneConnectionLabels([{ sourceNodeId: "a", targetNodeId: "b" }], new Map([["b", global]])).get("a")).toBe("Connected to Global");
  });
});
