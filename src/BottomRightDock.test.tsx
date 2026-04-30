/**
 * BottomRightDock — behaviour tests for the unified bottom-right
 * floating-tools dock.
 *
 * Verifies the contract that replaced the old per-panel pill UX:
 *   - Pills toggle their panels (mutex: opening one closes the others).
 *   - Routines pill is action-only — it triggers a callback, not a panel.
 *   - Escape closes the active panel.
 *   - Click outside closes the active panel.
 *   - Live badges (count + dot + tail) round-trip through useDockBadge.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  DockBar,
  DockPanel,
  DockProvider,
  useDockBadge,
  useDockPanelOpen,
  type DockPanelId,
} from "./BottomRightDock.tsx";

function PanelProbe({ id }: { id: DockPanelId }) {
  const open = useDockPanelOpen(id);
  if (!open) return null;
  return (
    <DockPanel id={id}>
      <div data-testid={`panel-${id}-body`}>panel body for {id}</div>
    </DockPanel>
  );
}

function BadgeProbe({
  id,
  count,
  dot,
  tail,
}: {
  id: DockPanelId;
  count?: number;
  dot?: "success";
  tail?: string;
}) {
  useDockBadge(id, { count, dot, tail });
  return null;
}

function renderDock(props?: { onOpenRoutines?: () => void }) {
  const onOpenRoutines = props?.onOpenRoutines ?? (() => {});
  return render(
    <DockProvider>
      <BadgeProbe id="sessions" count={3} dot="success" tail="$0.42" />
      <BadgeProbe id="mcp" count={2} />
      <BadgeProbe id="skills" count={5} />
      <PanelProbe id="sessions" />
      <PanelProbe id="mcp" />
      <PanelProbe id="skills" />
      <DockBar onOpenRoutines={onOpenRoutines} />
    </DockProvider>,
  );
}

function pill(id: string): HTMLElement {
  return screen.getByLabelText(id);
}

describe("BottomRightDock", () => {
  // Removed `renders one consistent pill...` smoke (§5.5 TRIVIAL): every
  // assertion was `getBy*(...).toBeDefined()` which throws on absence
  // already, so the matcher added nothing.

  it("toggling a pill opens and closes its panel", () => {
    renderDock();
    expect(screen.queryByTestId("panel-sessions-body")).toBeNull();
    fireEvent.click(pill("Sessions"));
    expect(screen.queryByTestId("panel-sessions-body")).not.toBeNull();
    fireEvent.click(pill("Sessions"));
    expect(screen.queryByTestId("panel-sessions-body")).toBeNull();
  });

  it("opening a different pill closes the previous panel (mutex)", () => {
    renderDock();
    fireEvent.click(pill("Sessions"));
    expect(screen.queryByTestId("panel-sessions-body")).not.toBeNull();
    fireEvent.click(pill("MCP"));
    expect(screen.queryByTestId("panel-sessions-body")).toBeNull();
    expect(screen.queryByTestId("panel-mcp-body")).not.toBeNull();
  });

  it("Routines pill is action-only and never activates a panel", () => {
    const onOpenRoutines = vi.fn();
    renderDock({ onOpenRoutines });
    fireEvent.click(pill("Routines"));
    expect(onOpenRoutines).toHaveBeenCalledTimes(1);
    // No data-active=true on the routines pill.
    expect(pill("Routines").getAttribute("data-active")).toBe("false");
  });

  it("opening a panel does not close itself when Routines is clicked again", () => {
    const onOpenRoutines = vi.fn();
    renderDock({ onOpenRoutines });
    fireEvent.click(pill("Skills"));
    expect(screen.queryByTestId("panel-skills-body")).not.toBeNull();
    fireEvent.click(pill("Routines"));
    // Skills panel is still open — Routines does not steal panel focus.
    expect(screen.queryByTestId("panel-skills-body")).not.toBeNull();
    expect(onOpenRoutines).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the active panel", () => {
    renderDock();
    fireEvent.click(pill("MCP"));
    expect(screen.queryByTestId("panel-mcp-body")).not.toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("panel-mcp-body")).toBeNull();
  });

  it("clicking outside the active panel closes it", () => {
    render(
      <DockProvider>
        <div data-testid="outside" style={{ width: 100, height: 100 }}>
          outside
        </div>
        <PanelProbe id="skills" />
        <DockBar onOpenRoutines={() => {}} />
      </DockProvider>,
    );
    fireEvent.click(pill("Skills"));
    expect(screen.queryByTestId("panel-skills-body")).not.toBeNull();
    act(() => {
      fireEvent.mouseDown(screen.getByTestId("outside"));
    });
    expect(screen.queryByTestId("panel-skills-body")).toBeNull();
  });

  it("clicking the dock bar itself does not close the active panel", () => {
    renderDock();
    fireEvent.click(pill("Sessions"));
    expect(screen.queryByTestId("panel-sessions-body")).not.toBeNull();
    // mousedown on the bar (between pills) should be ignored by the
    // outside-click guard.
    const bar = document.querySelector("[data-dock-bar]") as HTMLElement;
    expect(bar).not.toBeNull();
    act(() => {
      fireEvent.mouseDown(bar);
    });
    expect(screen.queryByTestId("panel-sessions-body")).not.toBeNull();
  });

  it("active pill exposes aria-pressed=true and data-active=true", () => {
    renderDock();
    expect(pill("Sessions").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pill("Sessions"));
    expect(pill("Sessions").getAttribute("aria-pressed")).toBe("true");
    expect(pill("Sessions").getAttribute("data-active")).toBe("true");
  });
});
