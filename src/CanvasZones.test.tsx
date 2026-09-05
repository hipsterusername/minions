import { useReducer, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasZones } from "./CanvasZones.tsx";
import { CanvasNodeComponent } from "./CanvasNode.tsx";
import { canvasReducer } from "./canvas-state.ts";
import { createZone, GLOBAL_WORKSPACE_ID } from "./canvas-zones.ts";
import { resetFeatureFlags } from "./feature-flags.ts";
import { useCanvasZones, type CanvasZonesController } from "./use-canvas-zones.ts";
import { registerNodeType } from "./node-registry.ts";
import type { CanvasAction, CanvasNode } from "./types.ts";

registerNodeType({ type: "leader", label: "Leader", defaultSize: { width: 100, height: 100 },
  render: () => <><div>Leader drag handle</div><input aria-label="Draft" defaultValue="keep my draft" /></> });
registerNodeType({ type: "minion", label: "Minion", defaultSize: { width: 100, height: 100 }, render: () => <span>Owned minion</span> });
const initial: CanvasNode[] = [
  { id: "leader", type: "leader", position: { x: 10, y: 20 }, size: { width: 100, height: 100 }, data: { taskName: "Repair callback", status: "running" } },
  { id: "minion", type: "minion", position: { x: 10, y: 160 }, size: { width: 100, height: 100 }, data: { leaderId: "leader" } },
  createZone("release", "Release prep"),
];
let c: CanvasZonesController;
let state: CanvasNode[];
let dispatch: React.Dispatch<CanvasAction>;
function Harness() {
  const [nodes, send] = useReducer(canvasReducer, initial);
  const [selectedIds, setSelectedIds] = useState(new Set(["leader"]));
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 120, y: 80, scale: .5 });
  c = useCanvasZones({ nodes, dispatch: send, selectedIds, setSelectedIds, containerRef, transform,
    reveal: (target, ids) => { setTransform(target); setSelectedIds(new Set(ids)); } });
  state = nodes; dispatch = send;
  return <div className="canvas-root" ref={containerRef}>
    <output data-testid="camera">{JSON.stringify(transform)}</output>
    {nodes.filter(n => n.type !== "canvas-zone").map(node => <CanvasNodeComponent key={node.id} node={node}
      parked={c.hiddenMembership.has(node.id)} isSelected={selectedIds.has(node.id)}
      onSelect={id => setSelectedIds(new Set([id]))} onMove={vi.fn()} onUpdateData={vi.fn()}
      onDragStart={c.beginDrag} onDragEnd={c.endDrag} onMoveToZone={c.choose} />)}
    <CanvasZones controller={c} nodes={nodes} selectedIds={selectedIds} transform={transform} />
  </div>;
}
function openWorkspaces() {
  const toggle = screen.getByRole("button", { name: /^Workspaces ·/ });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
}
function mount() { const result = render(<Harness />); openWorkspaces(); return result; }
function transfer() {
  fireEvent.click(screen.getByRole("button", { name: "Move selected to workspace…" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release prep" }));
}
function switchTo(name: string) { openWorkspaces(); fireEvent.click(screen.getByRole("button", { name: `Switch to ${name}` })); }
function deleteDialog() {
  openWorkspaces();
  fireEvent.click(screen.getByRole("button", { name: `Settings for ${c.zones.find(z => z.id === c.activeId)!.data.name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Delete workspace…" }));
  return within(screen.getByRole("dialog"));
}
beforeEach(() => {
  resetFeatureFlags();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => null) });
});

describe("Canvas workspaces", () => {
  it("dismisses notifications after six seconds and resets the timer for repeated messages and undo", () => {
    vi.useFakeTimers();
    try {
      const view = mount();
      transfer();
      act(() => vi.advanceTimersByTime(5_999));
      expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();

      // A new operation with identical copy still gets its full six seconds.
      switchTo("Release prep");
      act(() => c.park(["leader"], "release"));
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
      act(() => vi.advanceTimersByTime(5_998));
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      act(() => vi.advanceTimersByTime(5_999));
      expect(screen.getByText("Workspace change undone.")).toBeVisible();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText("Workspace change undone.")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Dismiss workspace notification" })).not.toBeInTheDocument();

      act(() => c.park(["leader"], "release"));
      act(() => vi.advanceTimersByTime(6_000));
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it("saves a library icon without switching workspaces, supports cancellation, reset and undo", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings for Release prep" }));
    const changeIcon = screen.getByRole("button", { name: "Change icon" });
    fireEvent.click(changeIcon);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search icons" }), { target: { value: "rocket" } });
    fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
    fireEvent.click(screen.getByRole("button", { name: "Save icon" }));
    await waitFor(() => expect(changeIcon).toHaveFocus());
    expect(c.activeId).toBe(GLOBAL_WORKSPACE_ID);
    expect(c.zones.find(z => z.id === "release")?.data.icon).toBe("minions:rocket");
    expect(screen.getByRole("button", { name: "Switch to Release prep" }).querySelector('[data-minions-icon="rocket"]')).not.toBeNull();
    fireEvent.click(changeIcon);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(c.zones.find(z => z.id === "release")?.data.icon).toBe("minions:rocket");
    fireEvent.click(changeIcon);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(screen.getByRole("button", { name: "Save icon" }));
    expect(c.zones.find(z => z.id === "release")?.data.icon).toBe("minions:folder");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(c.zones.find(z => z.id === "release")?.data.icon).toBe("minions:rocket");
    switchTo("Release prep");
    expect(screen.getByRole("button", { name: "Workspaces · Release prep" }).querySelector('[data-minions-icon="rocket"]')).not.toBeNull();
  });
  it("creates a workspace with an optional library icon", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Research" } });
    fireEvent.click(screen.getByText("Choose workspace icon"));
    fireEvent.click(screen.getByRole("button", { name: "Compass" }));
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    expect(c.zones.find(z => z.data.name === "Research")?.data.icon).toBe("minions:compass");
    expect(screen.getByRole("button", { name: "Workspaces · Research" }).querySelector('[data-minions-icon="compass"]')).not.toBeNull();
  });
  it("discloses destinations on demand and returns keyboard focus when dismissed", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Workspaces · Global" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Choose workspace" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Switch to Global" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    openWorkspaces();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "Choose workspace" })).toBeNull();
  });
  it("attaches management to its destination without switching the current workspace", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings for Release prep" }));
    expect(c.activeId).toBe(GLOBAL_WORKSPACE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue("Release prep");
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    expect(screen.getByRole("button", { name: "Switch to Launch" })).toBeVisible();
    expect(c.activeId).toBe(GLOBAL_WORKSPACE_ID);
    fireEvent.keyDown(screen.getByRole("button", { name: "Rename workspace" }), { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Rename workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings for Launch" })).toHaveFocus();
    expect(screen.getByRole("region", { name: "Choose workspace" })).toBeVisible();
  });
  it("temporarily reveals all drop destinations during a drag without stealing focus", () => {
    render(<Harness />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    draft.focus();
    act(() => c.beginDrag("leader"));
    expect(screen.getByRole("button", { name: "Switch to Release prep" })).toBeVisible();
    expect(draft).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Settings for Release prep" })).toBeNull();
    expect(screen.getByText("Drop 2 nodes on a destination below.")).toBeVisible();
    act(() => c.endDrag("leader"));
    expect(screen.queryByRole("region", { name: "Choose workspace" })).toBeNull();
  });
  it("always provides Global, with no rename or delete actions", () => {
    mount();
    expect(screen.getByRole("button", { name: "Switch to Global" })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("Workspace settings")).toBeNull();
    act(() => { c.requestDelete(GLOBAL_WORKSPACE_ID); c.remove(GLOBAL_WORKSPACE_ID); c.deleteAll(GLOBAL_WORKSPACE_ID); c.name([], GLOBAL_WORKSPACE_ID); });
    expect(c.dialog).toBeNull();
    expect(c.zones[0]?.data.name).toBe("Global");
    expect(state).toEqual(initial);
  });
  it("switches canvas content without unmounting drafts or changing layout, and fits each destination", () => {
    mount();
    const input = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(input, { target: { value: "unfinished input" } });
    transfer();
    expect(c.activeId).toBe(GLOBAL_WORKSPACE_ID);
    expect(input).not.toBeVisible();
    switchTo("Release prep");
    expect(input).toBeVisible();
    expect(screen.getByText("Owned minion")).toBeVisible();
    const camera = JSON.parse(screen.getByTestId("camera").textContent!);
    for (const node of state.filter(n => n.type !== "canvas-zone")) {
      expect(node.position.x * camera.scale + camera.x).toBeGreaterThanOrEqual(0);
      expect((node.position.x + node.size.width) * camera.scale + camera.x).toBeLessThanOrEqual(800);
    }
    switchTo("Global");
    act(() => dispatch({ type: "UPDATE_NODE_DATA", id: "leader", data: { status: "completed" } }));
    switchTo("Release prep");
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input).toHaveValue("unfinished input");
    expect(state.find(n => n.id === "leader")?.position).toEqual(initial[0]!.position);
    expect(state.find(n => n.id === "leader")?.data).toEqual({ status: "completed" });
    expect(screen.queryByRole("button", { name: /Return.*canvas/ })).toBeNull();
  });
  it("creates and enters an empty workspace, and puts new content there", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Ideas" } });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    expect(screen.getByRole("button", { name: "Switch to Ideas" })).toHaveAttribute("aria-current", "true");
    expect(c.visibleNodes).toHaveLength(0);
    act(() => dispatch({ type: "ADD_NODE", node: { ...initial[0]!, id: "new-note", type: "note" } }));
    expect(c.visibleNodes.map(n => n.id)).toEqual(["new-note"]);
    switchTo("Global");
    expect(c.visibleNodes.map(n => n.id)).toEqual(["leader", "minion"]);
    switchTo("Ideas");
    openWorkspaces();
    fireEvent.click(screen.getByRole("button", { name: "Settings for Ideas" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    expect(screen.getByRole("button", { name: "Switch to Research" })).toHaveAttribute("aria-current", "true");
  });
  it("moves any selected content between workspaces and undoes membership without losing live updates", () => {
    mount(); transfer();
    act(() => dispatch({ type: "UPDATE_NODE_DATA", id: "leader", data: { status: "completed" } }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(c.membership.has("leader")).toBe(false);
    expect(c.visibleNodes.map(n => n.id)).toEqual(["leader", "minion"]);
    expect(state.find(n => n.id === "leader")?.data).toEqual({ status: "completed" });
    act(() => dispatch({ type: "ADD_NODE", node: { ...initial[0]!, id: "note", type: "note" } }));
    act(() => c.choose("note"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release prep" }));
    switchTo("Release prep");
    expect(c.visibleNodes.map(n => n.id)).toEqual(["note"]);
    act(() => c.choose("note"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Global" }));
    expect(c.visibleNodes).toHaveLength(0);
    switchTo("Global");
    expect(c.visibleNodes.map(n => n.id)).toContain("note");
  });
  it("deleting a workspace can preserve its content in Global, and Undo restores it", () => {
    mount(); transfer(); switchTo("Release prep");
    fireEvent.click(deleteDialog().getByRole("button", { name: "Delete and move to Global" }));
    expect(c.activeId).toBe(GLOBAL_WORKSPACE_ID);
    expect(c.visibleNodes.map(n => n.id)).toEqual(["leader", "minion"]);
    expect(c.zones.map(z => z.data.name)).toEqual(["Global"]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(c.activeId).toBe("release");
    expect(c.membership.get("leader")?.id).toBe("release");
  });
  it("deletes all workspace content while retaining Global and unrelated nodes", () => {
    mount(); transfer();
    act(() => dispatch({ type: "ADD_NODE", node: { ...initial[0]!, id: "global-note", type: "note" } }));
    switchTo("Release prep");
    fireEvent.click(deleteDialog().getByRole("button", { name: "Delete all" }));
    expect(c.zones.map(z => z.data.name)).toEqual(["Global"]);
    expect(c.visibleNodes.map(n => n.id)).toEqual(["global-note"]);
    expect(c.activeId).toBe(GLOBAL_WORKSPACE_ID);
  });
  it("search and attention navigation switch to the owning workspace without opening fullscreen", () => {
    mount(); transfer();
    act(() => { expect(c.inspect("minion")).toBe(true); });
    expect(c.activeId).toBe("release");
    expect(screen.getByText("Owned minion")).toBeVisible();
    act(() => dispatch({ type: "ADD_NODE", node: { ...initial[0]!, id: "note", type: "note" } }));
    switchTo("Global");
    act(() => { expect(c.inspect("note")).toBe(true); });
    expect(c.activeId).toBe("release");
    expect(c.inspect("note")).toBe(false);
  });
  it("drag transfer preserves the original layout and supports Undo", () => {
    mount();
    const chip = screen.getByRole("button", { name: "Switch to Release prep" });
    vi.mocked(document.elementFromPoint).mockReturnValue(chip);
    fireEvent.mouseDown(screen.getByText("Leader drag handle"), { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 60, clientY: 50 });
    act(() => dispatch({ type: "MOVE_NODE", id: "leader", position: { x: 5000, y: 5000 } }));
    fireEvent.mouseMove(window, { clientX: 900, clientY: 100 });
    expect(chip).toHaveAttribute("data-target", "true");
    fireEvent.mouseUp(window, { clientX: 900, clientY: 100 });
    expect(c.membership.get("leader")?.id).toBe("release");
    expect(state.find(n => n.id === "leader")?.position).toEqual({ x: 10, y: 20 });
    act(() => c.undo());
    expect(c.membership.has("leader")).toBe(false);
  });
  it("Escape cancels a drag without transferring or moving content", () => {
    mount();
    fireEvent.mouseDown(screen.getByText("Leader drag handle"), { button: 0 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 });
    act(() => dispatch({ type: "MOVE_NODE", id: "leader", position: { x: 500, y: 500 } }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(state.find(n => n.id === "leader")?.position).toEqual({ x: 10, y: 20 });
    expect(c.dragCount).toBe(0);
  });
  it("keeps Global and the active workspace accessible during search", () => {
    mount();
    act(() => ["one", "two", "three"].forEach(id => dispatch({ type: "ADD_NODE", node: createZone(id, id) })));
    switchTo("three");
    openWorkspaces();
    fireEvent.change(screen.getByRole("textbox", { name: "Find workspace" }), { target: { value: "nothing" } });
    expect(screen.getByRole("button", { name: "Switch to Global" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Switch to three" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Switch to one" })).toBeNull();
  });
  it("keeps workspaces available with a stale disabled flag", () => {
    localStorage.setItem("minions:feature-flags", JSON.stringify({ "canvas-zones": false }));
    mount(); transfer();
    expect(screen.getByRole("complementary", { name: "Canvas workspaces" })).toBeVisible();
    expect(c.hiddenMembership.has("leader")).toBe(true);
    switchTo("Release prep");
    expect(screen.getByRole("textbox", { name: "Draft" })).toBeVisible();
  });
});
