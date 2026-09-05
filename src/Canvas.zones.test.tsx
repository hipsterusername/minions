import { useReducer, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { Canvas } from "./Canvas.tsx";
import { DockProvider } from "./BottomRightDock.tsx";
import { registerNodeType } from "./node-registry.ts";
import { canvasReducer } from "./canvas-state.ts";
import { createZone } from "./canvas-zones.ts";
import { resetFeatureFlags } from "./feature-flags.ts";
import type { CanvasNode, ContextItem } from "./types.ts";

registerNodeType({ type: "leader", label: "Leader", defaultSize: { width: 100, height: 100 }, render: () => <span>Live leader</span> });
registerNodeType({ type: "note", label: "Note", defaultSize: { width: 100, height: 100 }, render: () => <span>Visible note</span> });
const initial: CanvasNode[] = [
  { id: "leader", type: "leader", data: { status: "running", sessionKey: "s", taskPlan: [] }, position: { x: 10000, y: 10000 }, size: { width: 100, height: 100 } },
  { id: "note", type: "note", data: {}, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
  { ...createZone("zone", "Release"), data: { version: 1, name: "Release", leaderIds: ["leader"] } },
];
let current: CanvasNode[];
function Harness({ initialNodes = initial, socketConnected = false }: { initialNodes?: CanvasNode[]; socketConnected?: boolean }) {
  const [nodes, dispatch] = useReducer(canvasReducer, initialNodes);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  current = nodes;
  return <DockProvider><output data-testid="transform">{JSON.stringify(transform)}</output>
    <Canvas nodes={nodes} dispatch={dispatch} graph={{ edges: [] }} graphDispatch={vi.fn()}
      transform={transform} setTransform={setTransform} socketConnected={socketConnected} /></DockProvider>;
}
beforeEach(() => {
  resetFeatureFlags();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
it("combines live connection status with the default workspace switcher", () => {
  const { rerender } = render(<Harness socketConnected />);
  const toggle = screen.getByRole("button", { name: "Workspaces · Global" });
  expect(toggle).toContainElement(screen.getByText("Connected", { exact: true }));
  expect(toggle).toHaveAccessibleDescription("Connected");
  rerender(<Harness socketConnected={false} />);
  expect(toggle).toContainElement(screen.getByText("Disconnected", { exact: true }));
  expect(toggle).toHaveAccessibleDescription("Disconnected");
  fireEvent.click(toggle);
  expect(screen.getByRole("region", { name: "Choose workspace" })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Workspaces ·/ })).toBeVisible();
  expect(screen.getByText("Disconnected", { exact: true })).toBeVisible();
});
it("excludes parked nodes and zone metadata from fit and marquee/delete while leaving them mounted", () => {
  const { container } = render(<Harness />);
  const root = container.querySelector<HTMLElement>(".canvas-root")!;
  Object.defineProperties(root, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  expect(screen.getByText("Live leader")).not.toBeVisible();
  fireEvent.click(screen.getByTitle("Fit view"));
  const transform = JSON.parse(screen.getByTestId("transform").textContent!);
  expect(transform.scale).toBeGreaterThan(1);
  // At this viewport, the distant parked leader cannot influence the fit bounds.
  expect(transform.x).toBeGreaterThan(0);
  fireEvent.mouseDown(root, { button: 0, clientX: -10000, clientY: -10000 });
  fireEvent.mouseMove(window, { clientX: 30000, clientY: 30000 });
  fireEvent.mouseUp(window);
  fireEvent.keyDown(window, { key: "Delete", code: "Delete" });
  expect(current.map(n => n.id)).toContain("leader");
  expect(current.map(n => n.id)).toContain("zone");
  expect(current.map(n => n.id)).not.toContain("note");
  expect(screen.getByText("Live leader")).not.toBeVisible();
});

it("switches to a distant workspace and fits its retained layout without revealing Global content", () => {
  const { container } = render(<Harness />);
  const root = container.querySelector<HTMLElement>(".canvas-root")!;
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} });
  fireEvent.click(screen.getByRole("button", { name: /^Workspaces ·/ }));
  fireEvent.click(screen.getByRole("button", { name: "Switch to Release" }));
  expect(screen.getByText("Live leader")).toBeVisible();
  expect(screen.getByText("Visible note")).not.toBeVisible();
  const camera = JSON.parse(screen.getByTestId("transform").textContent!);
  const node = current.find(n => n.id === "leader")!;
  expect(node.position).toEqual({ x: 10000, y: 10000 });
  expect(node.position.x * camera.scale + camera.x).toBeGreaterThanOrEqual(0);
  expect((node.position.x + node.size.width) * camera.scale + camera.x).toBeLessThanOrEqual(800);
  expect(node.position.y * camera.scale + camera.y).toBeGreaterThanOrEqual(64);
  expect((node.position.y + node.size.height) * camera.scale + camera.y).toBeLessThanOrEqual(520);
  fireEvent.click(screen.getByRole("button", { name: /^Workspaces ·/ }));
  fireEvent.click(screen.getByRole("button", { name: "Switch to Global" }));
  expect(screen.getByText("Live leader")).not.toBeVisible();
  expect(screen.getByText("Visible note")).toBeVisible();
});

it("keeps spatial context groups isolated when nodes share coordinates across workspaces", () => {
  let readContext: (() => ContextItem[]) | undefined;
  registerNodeType({ type: "context-group", label: "Group", defaultSize: { width: 1000, height: 1000 },
    render: ({ getContextForNode }) => { readContext = getContextForNode; return <span>Context group</span>; } });
  registerNodeType({ type: "context-note", label: "Context note", defaultSize: { width: 100, height: 100 },
    providesContext: true, extractContent: data => (data as { content: string }).content, render: () => <span>Context note</span> });
  const content: CanvasNode[] = [
    { id: "group", type: "context-group", data: {}, position: { x: -100, y: -100 }, size: { width: 1000, height: 1000 } },
    { id: "global-note", type: "context-note", data: { content: "Global only" }, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
    { id: "release-note", type: "context-note", data: { content: "Release only" }, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
    { ...createZone("release", "Release"), data: { version: 1, name: "Release", leaderIds: [], nodeIds: ["release-note"] } },
  ];
  render(<Harness initialNodes={content} />);
  expect(readContext?.().map(item => item.content)).toEqual(["Global only"]);
  fireEvent.click(screen.getByRole("button", { name: /^Workspaces ·/ }));
  fireEvent.click(screen.getByRole("button", { name: "Switch to Release" }));
  expect(readContext?.().map(item => item.content)).toEqual(["Global only"]);
});
