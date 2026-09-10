import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createZone, GLOBAL_WORKSPACE_ID, readWorkspaces } from "../canvas-zones.ts";
import type { CanvasNode } from "../types.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

const leader: CanvasNode = { id: "leader", type: "leader", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { status: "running" } };
const release = createZone("release", "Release");
release.data = { ...release.data, icon: "minions:rocket", nodeIds: [leader.id], leaderIds: [leader.id] };
const nodes = [leader, release, createZone("research", "Research"), createZone("design", "Design")];
const props = { workspaces: readWorkspaces(nodes), nodes, value: "release", currentId: GLOBAL_WORKSPACE_ID, onChange: vi.fn() };

describe("WorkspacePicker", () => {
  it("creates and selects a workspace from an unmatched search", () => {
    const onCreate = vi.fn(() => "new-workspace");
    const onChange = vi.fn();
    render(<WorkspacePicker {...props} onCreate={onCreate} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Workspace Release" });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "New release" } });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    const create = screen.getByRole("button", { name: "Create workspace" });
    expect(create).toHaveFocus();
    fireEvent.click(create);
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    expect(name).toHaveFocus();
    expect(name).toHaveValue("New release");
    fireEvent.change(name, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "  Launch prep  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith("Launch prep");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("new-workspace");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("cancels workspace creation without changing the destination", () => {
    const onCreate = vi.fn(() => "new-workspace");
    const onChange = vi.fn();
    render(<WorkspacePicker {...props} onCreate={onCreate} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Workspace Release" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("searchbox")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Workspace name" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows workspace context and distinguishes the chosen destination from the current canvas", () => {
    function Harness() {
      const [value, setValue] = useState("release");
      return <WorkspacePicker {...props} value={value} onChange={setValue} />;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Workspace Release" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Launch in workspace" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("button", { name: "Choose Release" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "Choose Release" })).toHaveAccessibleDescription("1 working");
    expect(within(dialog).getByRole("button", { name: "Choose Global" })).toHaveAccessibleDescription("Empty workspace · Current canvas");
    expect(within(dialog).getByRole("button", { name: "Choose Global" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose Research" }));
    expect(trigger).toHaveAccessibleName("Workspace Research");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("supports search, empty-state recovery, keyboard navigation and Escape without changing the destination", () => {
    const onChange = vi.fn();
    render(<WorkspacePicker {...props} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Workspace Release" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = screen.getByRole("searchbox", { name: "Find workspace" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "  RESe  " } });
    expect(screen.getAllByRole("button", { name: /^Choose / })).toHaveLength(1);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Choose Research" })).toHaveFocus();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No workspaces found");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Choose Design" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("button", { name: "Choose Global" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects a filtered destination with Enter and dismisses on outside interaction", () => {
    const onChange = vi.fn();
    render(<><WorkspacePicker {...props} onChange={onChange} /><button>Next setting</button></>);
    const trigger = screen.getByRole("button", { name: "Workspace Release" });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "design" } });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("design");
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Next setting" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    screen.getByRole("button", { name: "Next setting" }).focus();
    fireEvent.focusIn(screen.getByRole("button", { name: "Next setting" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the portalled picker when the draft is hidden or begins launching", () => {
    const view = render(<WorkspacePicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace Release" }));
    view.rerender(<WorkspacePicker {...props} active={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<WorkspacePicker {...props} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Workspace Release" }));
    view.rerender(<WorkspacePicker {...props} disabled />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Workspace Release" })).toBeDisabled();
  });
});
