import { useReducer, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Canvas } from "./Canvas.tsx";
import { DockProvider } from "./BottomRightDock.tsx";
import { registerNodeType } from "./node-registry.ts";
import { canvasReducer } from "./canvas-state.ts";
import { graphReducer } from "./graph-runtime.ts";
import type { CanvasNode } from "./types.ts";
import { ActivityView } from "./ActivityView.tsx";

registerNodeType({ type: "leader", label: "Leader", defaultSize: { width: 250, height: 180 }, render: ({ node }) => <h2>{(node.data as { taskName: string }).taskName}</h2> });
const initial = { x: 40, y: 70, scale: .6 };
const initialNodes: CanvasNode[] = [
  { id: "first", type: "leader", position: { x: 100, y: 100 }, size: { width: 250, height: 180 }, data: { taskName: "Repair OAuth", sessionKey: "first-session", status: "idle", tasks: [] } },
  { id: "second", type: "leader", position: { x: 3000, y: 2200 }, size: { width: 250, height: 180 }, data: { taskName: "Review callback tests", sessionKey: "second-session", status: "waiting", tasks: [] } },
];
function Harness({ initialFocusNodeId = null }: { initialFocusNodeId?: string | null }) {
  const [nodes, dispatch] = useReducer(canvasReducer, initialNodes);
  const [graph, graphDispatch] = useReducer(graphReducer, { edges: [] });
  const [transform, setTransform] = useState(initial);
  const [focusNodeId, setFocusNodeId] = useState(initialFocusNodeId);
  return <DockProvider><output data-testid="camera">{JSON.stringify(transform)}</output><Canvas nodes={nodes} dispatch={dispatch} graph={graph} graphDispatch={graphDispatch} transform={transform} setTransform={setTransform} focusNodeId={focusNodeId} onFocusNodeHandled={() => setFocusNodeId(null)} activitySessions={[{ sessionKey: "second-session", sessionId: null, cwd: "/tmp", status: "waiting", role: "leader", taskName: "Review callback tests" }]} /></DockProvider>;
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Canvas wayfinding integration", () => {
  it("preserves a return view for a focus request received from Activity", () => {
    render(<Harness initialFocusNodeId="second" />);
    expect(screen.getByTestId("camera")).not.toHaveTextContent(JSON.stringify(initial));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("camera")).toHaveTextContent(JSON.stringify(initial));
  });
  it("finds an offscreen node, moves keyboard focus there, and returns to the original camera", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Find on canvas/ }));
    const input = screen.getByRole("textbox", { name: "Find on canvas" });
    fireEvent.change(input, { target: { value: "Review callback tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(screen.getByTestId("camera")).not.toHaveTextContent(JSON.stringify(initial));
    await waitFor(() => expect(document.activeElement?.getAttribute("data-canvas-node-id")).toBe("second"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("camera")).toHaveTextContent(JSON.stringify(initial));
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-canvas-node-id]")).toHaveLength(2);
  });
  it("routes the attention list through the same camera history", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Needs attention 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review callback tests.*Show on canvas/ }));
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(screen.getByTestId("camera")).not.toHaveTextContent(JSON.stringify(initial));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("camera")).toHaveTextContent(JSON.stringify(initial));
  });
  it("opens detached work directly in Activity with focus on its inspector", async () => {
    render(<ActivityView initialSelectedKey="session:detached" sessions={[{ sessionKey: "detached", sessionId: null, cwd: "/tmp", status: "waiting", role: "leader", taskName: "Detached decision" }]}
      nodes={[]} onLaunchLeader={() => {}} onCommitLaunchLeader={() => {}} onCancelLaunchLeader={() => {}} onOpenInCanvas={() => {}} onExpandFullscreen={() => {}} onStopSession={() => {}} onAttachToCanvas={() => {}} onUpdateNodeData={() => {}} />);
    const inspector = screen.getByRole("complementary", { name: "Session details" });
    expect(inspector).toHaveTextContent("Detached decision");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Detached decision"));
  });
});
