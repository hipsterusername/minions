import { useReducer, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { Canvas } from "./Canvas.tsx";
import { DockProvider } from "./BottomRightDock.tsx";
import { registerNodeType } from "./node-registry.ts";
import { canvasReducer } from "./canvas-state.ts";
import { canvasScale } from "./canvas-scale.ts";
import { resetFeatureFlags } from "./feature-flags.ts";
import { createZone } from "./canvas-zones.ts";
import type { CanvasNode } from "./types.ts";
import type { ProjectSettings } from "./api.ts";

registerNodeType({ type: "leader", label: "Leader", defaultSize: { width: 300, height: 200 },
  render: () => <div>Drag this leader<input aria-label="Live draft" defaultValue="Keep me" /></div> });
registerNodeType({ type: "note", label: "Note", defaultSize: { width: 300, height: 200 }, render: () => <span>Obstacle</span> });
registerNodeType({ type: "minion", label: "Minion", defaultSize: { width: 200, height: 100 }, render: () => <span>Attached minion</span> });
const initial: CanvasNode[] = [
  { id: "leader", type: "leader", data: { taskName: "Ship drag polish", status: "running" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
  { id: "note", type: "note", data: {}, position: { x: 400, y: 0 }, size: { width: 300, height: 200 } },
  createZone("release", "Release prep"),
];
let current: CanvasNode[];
function Harness({ initialNodes = initial, settings = {} }: { initialNodes?: CanvasNode[]; settings?: ProjectSettings }) {
  const [nodes, dispatch] = useReducer(canvasReducer, initialNodes);
  const [transform, setTransform] = useState({ x: 80, y: 60, scale: .5 });
  current = nodes;
  return <DockProvider><Canvas nodes={nodes} dispatch={dispatch} graph={{ edges: [] }} graphDispatch={vi.fn()}
    transform={transform} setTransform={setTransform} projectSettings={settings} /></DockProvider>;
}
beforeEach(() => {
  resetFeatureFlags(); canvasScale.current = .5;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => null) });
});

const snapScene = [initial[0]!, { ...initial[1]!, position: { x: 400, y: 100 }, size: { width: 300, height: 300 } }];
it("snaps by default, holds through small movements, and commits the exact preview", () => {
  const { container } = render(<Harness initialNodes={snapScene} />);
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 124 }); // raw (30,108), top aligns to 100
  expect(current[0]!.position).toEqual({ x: 30, y: 100 });
  fireEvent.mouseMove(window, { clientX: 106, clientY: 140 }); // 20 screen px away: still held
  expect(current[0]!.position).toEqual({ x: 32, y: 100 });
  expect(container.querySelector(".leader-drop-footprint")).toHaveStyle({ left: "32px", top: "100px" });
  fireEvent.mouseUp(window, { clientX: 106, clientY: 140 });
  expect(current[0]!.position).toEqual({ x: 32, y: 100 }); // no grid jump
});

it("releases to raw movement beyond the threshold and can snap again", () => {
  render(<Harness initialNodes={snapScene} settings={{ tidyLayout: false }} />);
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position.y).toBe(100);
  fireEvent.mouseMove(window, { clientX: 105, clientY: 146 });
  expect(current[0]!.position).toEqual({ x: 30, y: 152 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position.y).toBe(100);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(current[0]!.position).toEqual(snapScene[0]!.position);
});

it("respects disabled drag snapping independently of tidy layout", () => {
  render(<Harness initialNodes={snapScene} settings={{ snapWhileDragging: false, tidyLayout: false }} />);
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position).toEqual({ x: 30, y: 108 });
  fireEvent.mouseUp(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position).toEqual({ x: 30, y: 108 });
});

it("keeps free placement after breaking away with default settings, then resets for the next drag", () => {
  const { container } = render(<Harness initialNodes={snapScene} />);
  const leader = screen.getByText("Drag this leader");
  fireEvent.mouseDown(leader, { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position).toEqual({ x: 30, y: 100 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 146 });
  expect(current[0]!.position).toEqual({ x: 30, y: 152 });
  expect(container.querySelector(".leader-drop-footprint")).toHaveStyle({ left: "30px", top: "152px" });
  fireEvent.mouseUp(window, { clientX: 105, clientY: 146 });
  expect(current[0]!.position).toEqual({ x: 30, y: 152 });

  // A fresh drag that never acquires a magnetic alignment still uses tidy layout.
  fireEvent.mouseDown(leader, { button: 0, clientX: 105, clientY: 146 });
  fireEvent.mouseMove(window, { clientX: 85, clientY: 146 });
  expect(current[0]!.position).toEqual({ x: -10, y: 152 });
  fireEvent.mouseUp(window, { clientX: 85, clientY: 146 });
  expect(current[0]!.position).toEqual({ x: 0, y: 144 });
});

it("snaps an attached cluster as one box and restores its original offsets on cancellation", () => {
  const minion: CanvasNode = { id: "minion", type: "minion", data: { leaderId: "leader" },
    position: { x: 0, y: 240 }, size: { width: 200, height: 100 } };
  render(<Harness initialNodes={[...snapScene, minion]} />);
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position).toEqual({ x: 30, y: 100 });
  expect(current[2]!.position).toEqual({ x: 30, y: 340 });
  fireEvent.blur(window);
  expect(current[0]!.position).toEqual(snapScene[0]!.position);
  expect(current[2]!.position).toEqual(minion.position);
});

it("aligns ordinary nodes during dragging and preserves the alignment on drop", () => {
  render(<Harness initialNodes={snapScene} />);
  fireEvent.mouseDown(screen.getByText("Obstacle"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 95, clientY: 24 }); // raw (410,8) -> top at 0
  expect(current[1]!.position).toEqual({ x: 410, y: 0 });
  fireEvent.mouseUp(window, { clientX: 95, clientY: 24 });
  expect(current[1]!.position).toEqual({ x: 410, y: 0 });
});

it("aligns a multi-selection without changing offsets or snapping to itself", () => {
  const companion = { ...initial[1]!, id: "companion", position: { x: 0, y: 240 }, size: { width: 200, height: 100 } };
  const { container } = render(<Harness initialNodes={[snapScene[0]!, companion, snapScene[1]!]} />);
  for (const [element, shiftKey] of [[screen.getByText("Drag this leader"), false],
    [screen.getAllByText("Obstacle")[0]!, true]] as const) {
    fireEvent.mouseDown(element, { button: 0, clientX: 90, clientY: 70, shiftKey });
    fireEvent.mouseUp(window, { clientX: 90, clientY: 70 });
  }
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position).toEqual({ x: 30, y: 100 });
  expect(current[1]!.position).toEqual({ x: 30, y: 340 });
  expect(container.querySelector(".leader-drop-footprint")).toHaveStyle({ left: "30px", top: "100px", height: "340px" });
  fireEvent.mouseUp(window, { clientX: 105, clientY: 124 });
  expect(current[0]!.position).toEqual({ x: 30, y: 100 });
  expect(current[1]!.position).toEqual({ x: 30, y: 340 });
});

it.each(["Drag this leader", "Obstacle"])("hides the full mixed selection and previews its bounds when dragging %s", origin => {
  const { container } = render(<Harness />);
  const leader = screen.getByText("Drag this leader");
  const note = screen.getByText("Obstacle");
  const input = screen.getByLabelText("Live draft");
  for (const [element, shiftKey] of [[leader, false], [note, true]] as const) {
    fireEvent.mouseDown(element, { button: 0, clientX: 90, clientY: 70, shiftKey });
    fireEvent.mouseUp(window, { clientX: 90, clientY: 70 });
  }
  expect(leader).toBeVisible();
  expect(note).toBeVisible();
  fireEvent.mouseDown(screen.getByText(origin), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 190, clientY: 100 });
  expect(leader).not.toBeVisible();
  expect(note).not.toBeVisible();
  expect(input.closest(".canvas-node-card")).toHaveAttribute("inert");
  expect(container.querySelectorAll(".leader-drop-footprint")).toHaveLength(1);
  expect(container.querySelector(".leader-drop-footprint")).toHaveStyle({ left: "200px", top: "60px", width: "700px", height: "200px" });
  expect(screen.getByText("Place 2 nodes here")).toBeInTheDocument();
  expect(document.querySelectorAll(".leader-drag-card")).toHaveLength(1);
  expect(screen.getByText("2 nodes")).toBeVisible();
  const positions = current.filter(n => n.type !== "zone").map(n => ({ id: n.id, position: n.position }));
  fireEvent.mouseUp(window, { clientX: 190, clientY: 100 });
  expect(current.filter(n => n.type !== "zone").map(n => ({ id: n.id, position: n.position }))).toEqual(positions);
  expect(leader).toBeVisible();
  expect(note).toBeVisible();
  expect(screen.getByLabelText("Live draft")).toBe(input);
  expect(input).toHaveValue("Keep me");
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
});

it("includes attached minions in the hidden group and restores every member on cancellation", () => {
  const minion: CanvasNode = { id: "minion", type: "minion", data: { leaderId: "leader" },
    position: { x: 0, y: 260 }, size: { width: 200, height: 100 } };
  const { container } = render(<Harness initialNodes={[...initial, minion]} />);
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 130, clientY: 100 });
  expect(screen.getByText("Attached minion")).not.toBeVisible();
  expect(screen.getByText("Obstacle")).toBeVisible();
  expect(container.querySelector(".leader-drop-footprint")).toHaveStyle({ width: "300px", height: "360px" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(current.find(n => n.id === "minion")?.position).toEqual(minion.position);
  expect(current.find(n => n.id === "leader")?.position).toEqual(initial[0]!.position);
  expect(screen.getByText("Attached minion")).toBeVisible();
  expect(screen.getByLabelText("Live draft")).toBeVisible();
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
});

it("keeps both selected leaders hidden over a zone and restores the group on Escape", () => {
  const second: CanvasNode = { ...initial[0]!, id: "second", position: { x: 400, y: 0 } };
  const { container } = render(<Harness initialNodes={[initial[0]!, second, initial[2]!]} />);
  const leaders = screen.getAllByText("Drag this leader");
  const inputs = screen.getAllByLabelText("Live draft");
  leaders.forEach((leader, index) => {
    fireEvent.mouseDown(leader, { button: 0, clientX: 90, clientY: 70, shiftKey: index > 0 });
    fireEvent.mouseUp(window, { clientX: 90, clientY: 70 });
  });
  fireEvent.mouseDown(leaders[0]!, { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 190, clientY: 100 });
  expect(container.querySelector(".leader-drop-footprint")).toHaveStyle({ width: "700px", height: "200px" });
  const chip = document.querySelector('[data-zone-target="release"]');
  vi.mocked(document.elementFromPoint).mockReturnValue(chip);
  fireEvent.mouseMove(window, { clientX: 900, clientY: 100 });
  for (const leader of leaders) expect(leader).not.toBeVisible();
  expect(screen.getByText("Release into Release prep")).toBeVisible();
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
  expect(chip).toHaveAttribute("data-target", "true");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(current.find(n => n.id === "leader")?.position).toEqual(initial[0]!.position);
  expect(current.find(n => n.id === "second")?.position).toEqual(second.position);
  for (const input of inputs) { expect(input).toBeVisible(); expect(input).toHaveValue("Keep me"); }
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
  expect(document.querySelector(".leader-drag-card")).toBeNull();
});

it("previews and commits the nearby upper-right opening around an upper-left neighbor", () => {
  const initialNodes: CanvasNode[] = [
    { ...initial[0]!, size: { width: 200, height: 100 } },
    { id: "anchor", type: "note", data: {}, position: { x: 400, y: 0 }, size: { width: 400, height: 200 } },
    { id: "neighbor", type: "note", data: {}, position: { x: 300, y: -130 }, size: { width: 250, height: 100 } },
  ];
  const { container } = render(<Harness initialNodes={initialNodes} />);
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 340, clientY: 40 });
  expect(current.find(n => n.id === "leader")?.position).toEqual({ x: 500, y: -60 });
  expect(container.querySelector(".leader-drop-footprint")).toHaveStyle({ left: "566px", top: "-116px" });
  fireEvent.mouseUp(window, { clientX: 340, clientY: 40 });
  expect(current.find(n => n.id === "leader")?.position).toEqual({ x: 566, y: -116 });
});

it("previews the actual tidy drop at zoom while preserving full node size and draft", () => {
  const { container } = render(<Harness />);
  const input = screen.getByLabelText("Live draft");
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
  fireEvent.mouseMove(window, { clientX: 310, clientY: 80 });
  const footprint = container.querySelector<HTMLElement>(".leader-drop-footprint")!;
  expect(footprint).toHaveStyle({ width: "300px", height: "200px" });
  const preview = { x: parseFloat(footprint.style.left), y: parseFloat(footprint.style.top) };
  const leader = current.find(n => n.id === "leader")!;
  expect(leader.position.x).toBe(440); // 220 screen px at 0.5 zoom
  expect(preview).not.toEqual(leader.position); // overlapping the obstacle snaps to its edge
  expect(input).not.toBeVisible();
  fireEvent.mouseUp(window, { clientX: 310, clientY: 80 });
  expect(current.find(n => n.id === "leader")?.position).toEqual(preview);
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
  expect(screen.getByLabelText("Live draft")).toBe(input);
  expect(input).toBeVisible();
  expect(input).toHaveValue("Keep me");
});

it("switches between canvas footprint and zone cue, then cancels without moving or parking", () => {
  const { container } = render(<Harness />);
  fireEvent.mouseDown(screen.getByText("Drag this leader"), { button: 0, clientX: 90, clientY: 70 });
  fireEvent.mouseMove(window, { clientX: 200, clientY: 80 });
  expect(container.querySelector(".leader-drop-footprint")).not.toBeNull();
  const chip = document.querySelector('[data-zone-target="release"]');
  vi.mocked(document.elementFromPoint).mockReturnValue(chip);
  fireEvent.mouseMove(window, { clientX: 900, clientY: 100 });
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
  expect(screen.getByText("Release into Release prep")).toBeVisible();
  expect(chip).toHaveAttribute("data-target", "true");
  vi.mocked(document.elementFromPoint).mockReturnValue(null);
  fireEvent.mouseMove(window, { clientX: 200, clientY: 80 });
  expect(container.querySelector(".leader-drop-footprint")).not.toBeNull();
  expect(chip).toHaveAttribute("data-target", "false");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(current.find(n => n.id === "leader")?.position).toEqual({ x: 0, y: 0 });
  expect(screen.getByLabelText("Live draft")).toBeVisible();
  expect(container.querySelector(".leader-drop-footprint")).toBeNull();
});
