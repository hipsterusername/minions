import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortDot } from "./PortDot.tsx";

const input = {
  nodeId: "leader-1", nodeType: "leader", portId: "context-in",
  direction: "input" as const, protocol: "context", label: "Context", topPx: 190,
};

describe("leader port fins and hints", () => {
  it("explains the input on hover and keyboard focus, with Escape dismissal", () => {
    render(<PortDot {...input} />);
    const port = screen.getByRole("group", { name: "Context input" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseEnter(port);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Connect a context source here before starting the session.");
    expect(port).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    fireEvent.mouseLeave(port);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(port);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(port, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each([
    ["task-out", "task-assignment", "Assign Task", "Drag to a Minion’s task input"],
    ["context-out", "context", "Dashboard", "Drag to another leader’s context input"],
  ])("explains the %s output", (portId, protocol, label, hint) => {
    render(<PortDot {...input} direction="output" portId={portId} protocol={protocol} label={label} />);
    fireEvent.mouseEnter(screen.getByRole("group"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(hint);
  });

  it("explains locked context and blocks both connection callbacks", () => {
    const onConnectionStart = vi.fn();
    const onConnectionEnd = vi.fn();
    render(<PortDot {...input} locked onConnectionStart={onConnectionStart} onConnectionEnd={onConnectionEnd} />);
    const port = screen.getByRole("group");
    fireEvent.mouseEnter(port);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Context is fixed after this session starts.");
    fireEvent.mouseDown(port);
    fireEvent.mouseUp(port);
    expect(onConnectionStart).not.toHaveBeenCalled();
    expect(onConnectionEnd).not.toHaveBeenCalled();
  });

  it("preserves connection identity and hides hints during a drag", () => {
    const onConnectionStart = vi.fn();
    const onConnectionEnd = vi.fn();
    const { rerender } = render(<PortDot {...input} onConnectionStart={onConnectionStart} onConnectionEnd={onConnectionEnd} />);
    const port = screen.getByRole("group");
    fireEvent.mouseEnter(port);
    fireEvent.mouseDown(port);
    expect(onConnectionStart).toHaveBeenCalledWith({ nodeId: input.nodeId, nodeType: input.nodeType, portId: input.portId, direction: input.direction, protocol: input.protocol }, expect.anything());
    rerender(<PortDot {...input} isDragActive isValidTarget isSnapTarget onConnectionEnd={onConnectionEnd} />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseUp(port);
    expect(onConnectionEnd).toHaveBeenCalledWith({ nodeId: input.nodeId, nodeType: input.nodeType, portId: input.portId, direction: input.direction, protocol: input.protocol });
  });

  it("keeps ordinary node ports circular with their existing label", () => {
    const { container } = render(<PortDot {...input} nodeType="minion" />);
    expect(container.querySelector("svg")).toBeNull();
    fireEvent.mouseEnter(container.querySelector("[data-port-id]")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/^Context$/);
  });
});
