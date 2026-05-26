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
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  DockBar,
  DockPanel,
  DockProvider,
  DOCK_COMPACT_BREAKPOINT_PX,
  DOCK_TAIL_BREAKPOINT_PX,
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

function renderDock(props?: { onOpenRoutines?: (() => void) | undefined }) {
  const onOpenRoutines =
    props && "onOpenRoutines" in props
      ? props.onOpenRoutines
      : () => {};
  return render(
    <DockProvider>
      <BadgeProbe id="sessions" count={3} dot="success" tail="$0.42" />
      <BadgeProbe id="map" count={8} tail="75%" />
      <BadgeProbe id="mcp" count={2} />
      <BadgeProbe id="skills" count={5} />
      <PanelProbe id="sessions" />
      <PanelProbe id="map" />
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

  it("Map is a dock panel next to the other bottom tools", () => {
    renderDock();
    fireEvent.click(pill("Map"));
    expect(screen.queryByTestId("panel-map-body")).not.toBeNull();
    expect(pill("Map").getAttribute("data-active")).toBe("true");
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

  it("renders dock chrome inside fixed viewport overlays", () => {
    renderDock();
    const bar = document.querySelector("[data-dock-bar]") as HTMLElement;
    const barOverlay = bar.closest("[data-viewport-overlay]") as HTMLElement | null;
    expect(barOverlay).not.toBeNull();
    expect(barOverlay).toHaveStyle("position: fixed");
    expect(barOverlay).toHaveStyle("pointer-events: none");
    expect(bar).toHaveStyle("pointer-events: auto");

    fireEvent.click(pill("Sessions"));
    const panel = document.querySelector("[data-dock-panel='sessions']") as HTMLElement;
    const panelOverlay = panel.closest("[data-viewport-overlay]") as HTMLElement | null;
    expect(panelOverlay).not.toBeNull();
    expect(panelOverlay).toHaveStyle("position: fixed");
    expect(panel).toHaveStyle("pointer-events: auto");
  });

  it("hides the Routines pill when onOpenRoutines is undefined", () => {
    renderDock({ onOpenRoutines: undefined });
    expect(screen.queryByLabelText("Routines")).toBeNull();
    // Sibling pills are unaffected.
    expect(screen.getByLabelText("Sessions")).toBeInTheDocument();
  });

  it("shows a hover tooltip with the pill name when the label is hidden", () => {
    // Compact mode hides the inline label, so the custom tooltip must
    // render the name on hover — the canvas swallows native title=
    // tooltips, which is why the feature exists.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: DOCK_COMPACT_BREAKPOINT_PX - 200,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    renderDock();
    // No tooltip before hover.
    expect(document.querySelector("[data-dock-tooltip='sessions']")).toBeNull();
    fireEvent.mouseEnter(pill("Sessions"));
    const tooltip = document.querySelector("[data-dock-tooltip='sessions']");
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toBe("Sessions");
    fireEvent.mouseLeave(pill("Sessions"));
    expect(document.querySelector("[data-dock-tooltip='sessions']")).toBeNull();
  });

  it("does not duplicate the label as a tooltip when the inline label is already visible", () => {
    // In the full-width density the pill already shows "Sessions" inline.
    // Adding a tooltip with the same text would be redundant noise, so
    // the tooltip is suppressed.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: DOCK_TAIL_BREAKPOINT_PX + 200,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    renderDock();
    fireEvent.mouseEnter(pill("Sessions"));
    expect(document.querySelector("[data-dock-tooltip='sessions']")).toBeNull();
  });

  it("active pill exposes aria-pressed=true and data-active=true", () => {
    renderDock();
    expect(pill("Sessions").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pill("Sessions"));
    expect(pill("Sessions").getAttribute("aria-pressed")).toBe("true");
    expect(pill("Sessions").getAttribute("data-active")).toBe("true");
  });

  describe("responsive compact mode", () => {
    const originalWidth = window.innerWidth;

    function setViewportWidth(width: number) {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: width,
      });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
    }

    afterEach(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: originalWidth,
      });
    });

    it("shows full pills (label + tail) at wide viewport widths", () => {
      setViewportWidth(DOCK_TAIL_BREAKPOINT_PX + 200);
      renderDock();
      // Label text is rendered inside the pill; getByText finds it
      // regardless of the aria-label on the button wrapper.
      expect(screen.getByText("Sessions")).toBeInTheDocument();
      expect(screen.getByText("MCP")).toBeInTheDocument();
      // BadgeProbe sets tail="$0.42" on sessions.
      expect(screen.getByText("$0.42")).toBeInTheDocument();
      const bar = document.querySelector("[data-dock-bar]");
      expect(bar?.getAttribute("data-density")).toBe("full");
      expect(bar?.getAttribute("data-compact")).toBe("false");
    });

    it("drops tails but keeps labels in the mid-tier band", () => {
      // Mid-tier sits between compact and tail breakpoints. Pick the
      // midpoint so the test is robust to small threshold tweaks.
      const mid = Math.floor(
        (DOCK_COMPACT_BREAKPOINT_PX + DOCK_TAIL_BREAKPOINT_PX) / 2,
      );
      setViewportWidth(mid);
      renderDock();
      expect(screen.getByText("Sessions")).toBeInTheDocument();
      expect(screen.queryByText("$0.42")).toBeNull();
      const bar = document.querySelector("[data-dock-bar]");
      expect(bar?.getAttribute("data-density")).toBe("no-tail");
      expect(bar?.getAttribute("data-compact")).toBe("false");
    });

    it("uses icon-only mode at 1280px (the laptop width the user reported)", () => {
      // 1280px is a common laptop width where the labelled dock — even
      // without tails — couldn't clear the center Canvas toolbar.
      // Compact mode must engage here.
      setViewportWidth(1280);
      renderDock();
      expect(screen.queryByText("Sessions")).toBeNull();
      expect(screen.queryByText("MCP")).toBeNull();
      const bar = document.querySelector("[data-dock-bar]");
      expect(bar?.getAttribute("data-density")).toBe("compact");
      expect(bar?.getAttribute("data-compact")).toBe("true");
    });

    it("hides pill labels when viewport drops below the compact breakpoint", () => {
      setViewportWidth(DOCK_TAIL_BREAKPOINT_PX + 200);
      renderDock();
      expect(screen.getByText("Sessions")).toBeInTheDocument();

      // Shrink to a phone-ish width. The dock should switch to icon-only.
      setViewportWidth(DOCK_COMPACT_BREAKPOINT_PX - 200);

      expect(screen.queryByText("Sessions")).toBeNull();
      expect(screen.queryByText("MCP")).toBeNull();
      // The button itself (and its aria-label) still exists so the pill
      // stays operable and screen-readable.
      expect(pill("Sessions")).toBeInTheDocument();
      const bar = document.querySelector("[data-dock-bar]");
      expect(bar?.getAttribute("data-density")).toBe("compact");
      expect(bar?.getAttribute("data-compact")).toBe("true");
    });

    it("hides the tail copy in compact mode but keeps the count badge", () => {
      setViewportWidth(DOCK_COMPACT_BREAKPOINT_PX - 200);
      renderDock();
      // BadgeProbe sets tail="$0.42" on sessions and count=3.
      expect(screen.queryByText("$0.42")).toBeNull();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });
});
