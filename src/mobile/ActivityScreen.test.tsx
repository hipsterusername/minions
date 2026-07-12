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
  it("does not open synthetic draft work items as nonexistent sessions", () => {
    const onOpenSession = vi.fn();
    render(<ActivityScreen sessions={[session({ sessionKey: "work-item:draft", workItemId: "draft" })]}
      onOpenSession={onOpenSession} />);
    const card = screen.getByTitle("No run has started for this work item");
    expect(card).toBeDisabled();
    fireEvent.click(card);
    expect(onOpenSession).not.toHaveBeenCalled();
  });
  it("expands canonical run history and requests subsequent pages", () => {
    const load = vi.fn();
    render(<ActivityScreen sessions={[session({ sessionKey: "run-1", workItemId: "work-1", taskName: "Task" })]}
      onOpenSession={() => {}} onLoadRuns={load} runNextCursor={{ "work-1": "next" }}
      workItemRuns={{ "work-1": [{ runKey: "run-1", workItemId: "work-1", runKind: "primary",
        parentRunKey: null, taskId: null, runNumber: 1, previousRunKey: null,
        providerSessionId: null, outcome: "completed", startedAt: 1, endedAt: 2,
        finalReport: "Shipped safely" }] }} />);
    fireEvent.click(screen.getByText("Run history"));
    expect(screen.getByText(/Iteration 1 · completed/)).toBeInTheDocument();
    expect(screen.getByText("Shipped safely")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(load).toHaveBeenCalledWith("work-1", "next");
  });

  it("keeps non-dismissed completions visible and hides dismissed history", () => {
    const lifecycle = {
      reviewState: "completion_to_review" as const,
      reviewReason: "Review completion",
      finalReport: "Done",
      finalDashboardRevision: 1,
      dashboardRevision: 1,
      terminalReason: "completed" as const,
      terminalAt: 1,
      acknowledgedAt: null,
      dismissedAt: null,
      lifecycleRevision: 1,
    };
    render(<ActivityScreen sessions={[
      session({ sessionKey: "open", taskName: "Read me", reviewLifecycle: lifecycle }),
      session({ sessionKey: "dismissed", taskName: "Hidden history", reviewLifecycle: { ...lifecycle, dismissedAt: 2 } }),
    ]} onOpenSession={() => {}} />);
    expect(screen.getByText("Read me")).toBeInTheDocument();
    expect(screen.getByText("complete · read report")).toBeInTheDocument();
    expect(screen.queryByText("Hidden history")).not.toBeInTheDocument();
  });
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

  it("surfaces a leader's active minion counts on its card", () => {
    render(
      <ActivityScreen
        sessions={[
          session({
            sessionKey: "leader-1",
            role: "leader",
            status: "running",
            taskName: "Ship mobile",
            activeMinions: [
              { taskId: "a", title: "A", status: "running", sessionKey: "m-a" },
              { taskId: "b", title: "B", status: "running", sessionKey: "m-b" },
              { taskId: "c", title: "C", status: "blocked", sessionKey: "m-c" },
            ],
          }),
        ]}
        onOpenSession={() => {}}
      />,
    );

    const card = screen.getByRole("button", { name: /ship mobile/i });
    const summary = within(card).getByLabelText("Active minions summary");
    expect(within(summary).getByText("2 running")).toBeInTheDocument();
    expect(within(summary).getByText("1 blocked")).toBeInTheDocument();
  });

  it("omits the minion summary when a leader has no active minions", () => {
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "leader-1", role: "leader", status: "running", taskName: "Solo leader" })]}
        onOpenSession={() => {}}
      />,
    );

    const card = screen.getByRole("button", { name: /solo leader/i });
    expect(within(card).queryByLabelText("Active minions summary")).not.toBeInTheDocument();
  });

  it("shows a prominent activity notice with actions", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();

    render(
      <ActivityScreen
        sessions={[]}
        onOpenSession={() => {}}
        notice={{
          title: "Session limit reached",
          message: "Stop idle sessions before launching again.",
          actionLabel: "Open session to stop",
          onAction,
          onDismiss,
        }}
      />,
    );

    expect(screen.getByRole("alert", { name: "Session limit reached" })).toBeInTheDocument();
    expect(screen.getByText("Stop idle sessions before launching again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open session to stop" }));
    expect(onAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
