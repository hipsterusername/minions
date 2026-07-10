/**
 * Tests for LeaderBody — the responsive chat｜dashboard layout that embeds the
 * dashboard in the Leader node (replacing the retired standalone render node).
 *
 * Covers:
 *   - Progressive disclosure: no dashboard data → chat only, no tabs.
 *   - Narrow (no/zero width) → tabbed with a chat-forward default.
 *   - Tab switching notifies the host and reveals the dashboard.
 *   - Wide → split-pane shows both chat and dashboard simultaneously.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaderBody } from "./LeaderBody.tsx";
import type { RenderState } from "../../../shared/render-dsl.ts";

const CHAT = <div data-testid="chat-slot">chat content</div>;

const EMPTY: RenderState = { layout: {}, components: [] };
const WITH_CONTENT: RenderState = {
  layout: { title: "Dash" },
  components: [{ id: "m1", type: "metric", label: "PRs", value: "3" }],
};

/** Install a ResizeObserver mock that reports a fixed content width. */
function mockResizeObserver(width: number) {
  class RO {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LeaderBody — progressive disclosure", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("renders chat only (no tabs) when there is no dashboard data", () => {
    render(<LeaderBody chat={CHAT} renderState={EMPTY} />);
    expect(screen.getByTestId("chat-slot")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Dashboard" })).toBeNull();
  });

  it("reveals the dashboard side for the plan even with no render content", () => {
    mockResizeObserver(400);
    render(
      <LeaderBody
        chat={CHAT}
        renderState={EMPTY}
        activeBodyView="dashboard"
        dashboardHeaderActive
        dashboardHeader={<div data-testid="plan-slot">plan</div>}
      />,
    );
    // Tabbed (narrow): the Dashboard tab exists and the plan lives on it.
    expect(screen.getByRole("tab", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByTestId("plan-slot")).toBeInTheDocument();
  });

  it("does not reveal the dashboard side when the plan is inactive", () => {
    mockResizeObserver(400);
    render(
      <LeaderBody
        chat={CHAT}
        renderState={EMPTY}
        dashboardHeaderActive={false}
        dashboardHeader={<div data-testid="plan-slot">plan</div>}
      />,
    );
    expect(screen.queryByRole("tab", { name: "Dashboard" })).toBeNull();
    expect(screen.queryByTestId("plan-slot")).toBeNull();
  });

  it("keeps the plan in the dashboard half of the split when wide", () => {
    mockResizeObserver(900);
    render(
      <LeaderBody
        chat={CHAT}
        renderState={WITH_CONTENT}
        dashboardHeaderActive
        dashboardHeader={<div data-testid="plan-slot">plan</div>}
      />,
    );
    // Split mode: plan and dashboard render together, no full-width tab bar.
    expect(screen.getByTestId("plan-slot")).toBeInTheDocument();
    expect(screen.getByText("PRs")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Dashboard" })).toBeNull();
  });
});

describe("LeaderBody — narrow (tabbed)", () => {
  beforeEach(() => mockResizeObserver(400));

  it("shows a chat-forward tab toggle once there is dashboard data", () => {
    render(<LeaderBody chat={CHAT} renderState={WITH_CONTENT} />);
    const chatTab = screen.getByRole("tab", { name: "Conversation" });
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Dashboard" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("switching to the Dashboard tab notifies the host and reveals the dashboard", () => {
    const onActiveBodyViewChange = vi.fn();
    const { rerender } = render(
      <LeaderBody
        chat={CHAT}
        renderState={WITH_CONTENT}
        onActiveBodyViewChange={onActiveBodyViewChange}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
    expect(onActiveBodyViewChange).toHaveBeenCalledWith("dashboard");

    rerender(
      <LeaderBody
        chat={CHAT}
        renderState={WITH_CONTENT}
        activeBodyView="dashboard"
        onActiveBodyViewChange={onActiveBodyViewChange}
      />,
    );
    expect(screen.getByText("PRs")).toBeInTheDocument();
  });
});

describe("LeaderBody — wide (split)", () => {
  beforeEach(() => mockResizeObserver(900));

  it("shows chat and dashboard together with a resize divider", () => {
    render(<LeaderBody chat={CHAT} renderState={WITH_CONTENT} />);
    expect(screen.getByTestId("chat-slot")).toBeInTheDocument();
    expect(screen.getByText("PRs")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: /resize conversation and dashboard/i }),
    ).toBeInTheDocument();
    // No tab bar in split mode.
    expect(screen.queryByRole("tab", { name: "Dashboard" })).toBeNull();
  });
});
