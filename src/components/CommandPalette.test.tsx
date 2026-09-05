import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.tsx";
import type { CanvasNode } from "../types.ts";

const nodes: CanvasNode[] = [
  { id: "auth", type: "leader", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { taskName: "Repair OAuth" } },
  { id: "tests", type: "minion", position: { x: 400, y: 0 }, size: { width: 100, height: 100 }, data: { title: "OAuth tests" } },
];
function mount() {
  const onCreate = vi.fn(), onJump = vi.fn(), onClose = vi.fn();
  render(<CommandPalette items={[{ kind: "node", type: "leader", label: "New Leader" }]} nodes={nodes} onCreate={onCreate} onJump={onJump} onClose={onClose} nodeContext={{ tests: "Leader: Repair OAuth · waiting" }} zoneNames={new Map([["tests", "Release prep"]])} />);
  return { onCreate, onJump, onClose };
}

describe("Canvas palette navigation", () => {
  it("opens a matching node on Enter without creating anything", () => {
    const { onCreate, onJump } = mount();
    const input = screen.getByRole("textbox", { name: "Find on canvas" });
    fireEvent.change(input, { target: { value: "Repair OAuth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith("auth");
    expect(onCreate).not.toHaveBeenCalled();
  });
  it("never creates for an unmatched query, including after moving up from the first result", () => {
    const { onCreate, onJump } = mount();
    const input = screen.getByRole("textbox", { name: "Find on canvas" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.change(input, { target: { value: "unknown destination" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(/No matching nodes/)).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onJump).not.toHaveBeenCalled();
  });
  it("allows explicit creation and preserves the entered content", () => {
    const { onCreate } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Create node" }));
    const input = screen.getByRole("textbox", { name: "New node content" });
    fireEvent.change(input, { target: { value: "Investigate login" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith({ kind: "node", type: "leader", label: "New Leader" }, "Investigate login");
  });
  it("shows zone and parent context and supports choosing the second destination", () => {
    const { onJump } = mount();
    expect(screen.getByText(/Open in Release prep · Leader: Repair OAuth · waiting/)).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Find on canvas" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith("tests");
  });
  it("does not submit during IME composition and closes once on Escape", () => {
    const { onJump, onClose } = mount();
    const input = screen.getByRole("textbox", { name: "Find on canvas" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("keeps Tab focus inside the dialog", () => {
    mount();
    const first = screen.getByRole("button", { name: "Find on canvas" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    const last = screen.getByRole("button", { name: /OAuth tests/ });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
  });
});
