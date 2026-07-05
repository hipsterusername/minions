import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityScreen } from "./ActivityScreen.tsx";
import type { MobileSessionInfo } from "./mobile-selectors.ts";

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: overrides.status ?? "idle",
    cwd: "/tmp/project",
    ...overrides,
  };
}

describe("ActivityScreen", () => {
  it("groups sessions into activity sections in Active → Idle → Stopped order", () => {
    render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "blocked", status: "idle", taskName: "Needs answer", pendingAttention: true }),
          session({ sessionKey: "running", status: "running", taskName: "Working session", lastActivityAt: 100 }),
          session({ sessionKey: "done", status: "completed", taskName: "Finished job" }),
        ]}
        onOpenSession={() => {}}
      />,
    );

    // Section headers render in the fixed order.
    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Active",
      "Idle",
      "Stopped / Cleared",
    ]);

    // Active is the first section, so the running session's card precedes the
    // idle/attention one — attention no longer floats above active work.
    const cards = screen.getAllByRole("button");
    expect(within(cards[0]!).getByText("Working session")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("Needs answer")).toBeInTheDocument();
    expect(within(cards[2]!).getByText("Finished job")).toBeInTheDocument();
  });

  it("places an errored session in the Idle section with the attention highlight", () => {
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "err", status: "error", taskName: "Crashed run" })]}
        onOpenSession={() => {}}
      />,
    );

    const idle = screen.getByRole("region", { name: "Idle" });
    const card = within(idle).getByRole("button");
    expect(card).toHaveClass("mob-session-card--attention");
    expect(within(card).getByText("Crashed run")).toBeInTheDocument();
  });

  it("does not display minion sessions and excludes them from the count", () => {
    const { container } = render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "leader-1", role: "leader", status: "running", taskName: "Leader run" }),
          session({ sessionKey: "leader-2", role: "leader", status: "running", taskName: "Second leader" }),
          session({ sessionKey: "minion-1", role: "minion", status: "running", taskName: "Minion run" }),
        ]}
        onOpenSession={() => {}}
      />,
    );

    expect(screen.getByText("Leader run")).toBeInTheDocument();
    expect(screen.queryByText("Minion run")).not.toBeInTheDocument();
    // Header count reflects only the visible (non-minion) sessions.
    expect(container.querySelector(".mob-count")?.textContent).toBe("2");
  });

  it("shows the empty state when only minion sessions exist", () => {
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "minion-1", role: "minion", status: "running", taskName: "Minion run" })]}
        onOpenSession={() => {}}
      />,
    );

    expect(screen.getByText("No sessions are running.")).toBeInTheDocument();
    expect(screen.queryByText("Minion run")).not.toBeInTheDocument();
  });

  it("opens a session when its card is tapped", () => {
    const onOpenSession = vi.fn();
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "leader-1", taskName: "Ship mobile" })]}
        onOpenSession={onOpenSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /ship mobile/i }));
    expect(onOpenSession).toHaveBeenCalledWith("leader-1");
  });
});

