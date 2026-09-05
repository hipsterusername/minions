import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasNavigation } from "./CanvasNavigation.tsx";
import type { CanvasAttentionItem } from "../canvas-attention.ts";

const attached: CanvasAttentionItem = { nodeId: "node", title: "Repair login", reason: "waiting for you", session: { sessionKey: "s1", sessionId: null, cwd: "/tmp", status: "waiting" } };
const detached: CanvasAttentionItem = { ...attached, nodeId: null, title: "Review tests", session: { ...attached.session, sessionKey: "s2" } };
function mount(attention = [attached, detached]) {
  const onAttention = vi.fn(), onBack = vi.fn(), onFind = vi.fn();
  const props = { top: 50, canGoBack: false, onBack, onFind, attention, onAttention, announcement: "" };
  return { ...render(<CanvasNavigation {...props} />), props };
}
describe("Canvas navigation controls", () => {
  it("follows the panel edge as its occupied width changes", () => {
    const { props, rerender } = mount();
    rerender(<CanvasNavigation {...props} left={374} />);
    expect(screen.getByRole("navigation").parentElement).toHaveStyle({ left: "374px" });
    rerender(<CanvasNavigation {...props} left={162} />);
    expect(screen.getByRole("navigation").parentElement).toHaveStyle({ left: "162px" });
  });
  it("exposes Find and only shows Back when there is a previous view", () => {
    const { props, rerender } = mount();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Find on canvas/ }));
    expect(props.onFind).toHaveBeenCalledOnce();
    rerender(<CanvasNavigation {...props} canGoBack />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(props.onBack).toHaveBeenCalledOnce();
  });
  it("shows named destinations and routes attached and detached work", () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole("button", { name: /Needs attention 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /Repair login.*Show on canvas/ }));
    expect(props.onAttention).toHaveBeenLastCalledWith(attached);
    fireEvent.click(screen.getByRole("button", { name: /Needs attention 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review tests.*Open in Activity/ }));
    expect(props.onAttention).toHaveBeenLastCalledWith(detached);
  });
  it("shows the empty state and restores trigger focus on Escape", () => {
    mount([]);
    const trigger = screen.getByRole("button", { name: /Needs attention 0/ });
    fireEvent.click(trigger);
    expect(screen.getByText("No work needs your attention.")).toBeVisible();
    const close = screen.getByRole("button", { name: "Close attention list" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
