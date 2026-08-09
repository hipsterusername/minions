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
  it("does not repeat the session title as card activity", () => {
    render(
      <ActivityScreen
        sessions={[
          session({
            sessionKey: "duplicate",
            taskName: "Release checklist",
            lastActivity: "  release CHECKLIST  ",
          }),
          session({
            sessionKey: "distinct",
            taskName: "Dependency audit",
            lastActivity: "Checking production licenses",
          }),
        ]}
        onOpenSession={() => {}}
      />,
    );

    const duplicateCard = screen
      .getByText("Release checklist", { selector: ".mob-card-title" })
      .closest(".mob-session-card")!;
    expect(duplicateCard.querySelector(".mob-card-activity")).toBeNull();

    const distinctCard = screen
      .getByText("Dependency audit", { selector: ".mob-card-title" })
      .closest(".mob-session-card")!;
    expect(distinctCard.querySelector(".mob-card-activity"))
      .toHaveTextContent("Checking production licenses");
  });

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
    render(<ActivityScreen sessions={[session({ sessionKey: "run-2", workItemId: "work-1", taskName: "Task" })]}
      onOpenSession={() => {}} onLoadRuns={load} runNextCursor={{ "work-1": "next" }}
      workItemRuns={{ "work-1": [{ runKey: "run-1", workItemId: "work-1", runKind: "primary",
        parentRunKey: null, taskId: null, runNumber: 1, previousRunKey: null,
        providerSessionId: null, outcome: "completed", startedAt: 1, endedAt: 2,
        finalReport: "Shipped safely" }] }} />);
    fireEvent.click(screen.getByText("Run history"));
    const history = screen.getByText("Run history").closest("details");
    history!.open = true;
    fireEvent(history!, new Event("toggle", { bubbles: true }));
    expect(history).toHaveClass("mob-run-history");
    expect(within(history!).getByText("Iteration 1")).toBeInTheDocument();
    expect(within(history!).getByText("completed")).toBeInTheDocument();
    expect(screen.queryByText("Shipped safely")).not.toBeInTheDocument();
    fireEvent.click(within(history!).getByRole("button", { name: "Preview" }));
    expect(within(history!).getByRole("region", { name: "Preview of iteration 1" }))
      .toHaveTextContent("Shipped safely");
    expect(load).toHaveBeenCalledWith("work-1", "next");
  });

  it("gives an empty run-history disclosure a settled empty state", () => {
    const load = vi.fn();
    render(<ActivityScreen sessions={[session({ sessionKey: "run-1", workItemId: "work-1" })]}
      onOpenSession={() => {}} onLoadRuns={load} />);

    const history = screen.getByText("Run history").closest("details")!;
    history.open = true;
    fireEvent(history, new Event("toggle", { bubbles: true }));
    expect(screen.getByText("No previous iterations loaded.")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith("work-1", undefined);
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
  it("pins attention sessions to a Needs-you lane above the status sections", () => {
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

    // The attention session floats out of Idle into the pinned triage lane,
    // which renders first; the calm sessions stay in their status buckets.
    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Needs you",
      "Active",
      "Stopped / Cleared",
    ]);

    const triage = screen.getByRole("region", { name: "Needs you" });
    expect(within(triage).getByText("Needs answer")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Active" })).getByText("Working session")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Stopped / Cleared" })).getByText("Finished job")).toBeInTheDocument();
  });

  it("surfaces an errored session in the Needs-you lane with its reason", () => {
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "err", status: "error", taskName: "Crashed run" })]}
        onOpenSession={() => {}}
      />,
    );

    const triage = screen.getByRole("region", { name: "Needs you" });
    const row = within(triage).getByText("Crashed run").closest(".mob-triage-row");
    expect(row).toHaveClass("mob-triage-row--error");
    expect(within(triage).getByText("errored")).toBeInTheDocument();
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

  const waitingLifecycle = {
    reviewState: "decision_needed" as const,
    reviewReason: "Needs a decision",
    finalReport: null,
    finalDashboardRevision: 0,
    dashboardRevision: 0,
    terminalReason: null,
    terminalAt: null,
    acknowledgedAt: null,
    dismissedAt: null,
    lifecycleRevision: 3,
  };

  it("presents retained inactive work as a neutral keep-or-remove choice", () => {
    const send = vi.fn();
    const inactiveLifecycle = {
      ...waitingLifecycle,
      reviewState: "interrupted_to_review" as const,
      reviewReason: "Inactive",
      terminalReason: "abort" as const,
      terminalAt: 10,
    };
    const { container } = render(
      <ActivityScreen
        sessions={[session({
          sessionKey: "inactive",
          status: "inactive",
          taskName: "Paused work",
          reviewLifecycle: inactiveLifecycle,
        })]}
        onOpenSession={() => {}}
        send={send}
      />,
    );

    const row = container.querySelector(".mob-triage-row") as HTMLElement;
    expect(row).toHaveClass("mob-triage-row--inactive");
    expect(row).not.toHaveClass("mob-triage-row--error");
    expect(within(row).queryByRole("button", { name: "View" })).not.toBeInTheDocument();

    const review = within(row).getByRole("button", { name: "Review" });
    const remove = within(row).getByRole("button", {
      name: "Review and remove from Activity",
    });
    expect(review).toHaveTextContent("");
    expect(review.querySelector("svg")).toBeInTheDocument();
    expect(remove).toHaveTextContent("");
    expect(remove.querySelector(".lucide-list-x")).toBeInTheDocument();

    fireEvent.click(review);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "acknowledge_session",
      sessionKey: "inactive",
    }));

    fireEvent.click(remove);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "dismiss_session",
      sessionKey: "inactive",
    }));
  });

  it("summarizes needs-you, active, and waiting counts", () => {
    const { container } = render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "wait", status: "waiting", taskName: "Blocked", reviewLifecycle: waitingLifecycle }),
          session({ sessionKey: "run", status: "running", taskName: "Busy" }),
        ]}
        onOpenSession={() => {}}
      />,
    );
    const summary = container.querySelector(".mob-activity-summary")!;
    expect(within(summary as HTMLElement).getByText("needs you").previousSibling).toHaveTextContent("1");
    expect(within(summary as HTMLElement).getByText("active").previousSibling).toHaveTextContent("1");
    expect(within(summary as HTMLElement).getByText("waiting").previousSibling).toHaveTextContent("1");
  });

  it("filters from the summary counts and clears the filter on a second tap", () => {
    render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "wait", status: "waiting", taskName: "Needs answer", reviewLifecycle: waitingLifecycle }),
          session({ sessionKey: "run", status: "running", taskName: "In progress" }),
          session({ sessionKey: "idle", status: "idle", taskName: "Taking a break" }),
        ]}
        onOpenSession={() => {}}
      />,
    );

    const activeFilter = screen.getByRole("button", { name: /active: 1\. filter activity/i });
    fireEvent.click(activeFilter);
    expect(activeFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.queryByText("Needs answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Taking a break")).not.toBeInTheDocument();

    fireEvent.click(activeFilter);
    expect(activeFilter).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Needs answer")).toBeInTheDocument();
    expect(screen.getByText("Taking a break")).toBeInTheDocument();
  });

  it("keeps the summary controls available when a selected filter has no matches", () => {
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "idle", status: "idle", taskName: "Taking a break" })]}
        onOpenSession={() => {}}
      />,
    );

    const waitingFilter = screen.getByRole("button", { name: /waiting: 0\. filter activity/i });
    fireEvent.click(waitingFilter);
    expect(screen.getByText("No sessions match this activity filter.")).toBeInTheDocument();
    expect(waitingFilter).toBeInTheDocument();
    fireEvent.click(waitingFilter);
    expect(screen.getByText("Taking a break")).toBeInTheDocument();
  });

  it("clears the summary filter when visibility changes", () => {
    render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "open", status: "running", taskName: "Open active" }),
          session({ sessionKey: "gone", status: "idle", taskName: "Dismissed idle",
            reviewLifecycle: { ...waitingLifecycle, dismissedAt: 5 } }),
        ]}
        onOpenSession={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /active: 1\. filter activity/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Dismissed" }));
    expect(screen.getByText("Dismissed idle")).toBeInTheDocument();
  });

  it("filters to dismissed sessions when the Dismissed tab is selected", () => {
    render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "open", taskName: "Open one", reviewLifecycle: waitingLifecycle }),
          session({ sessionKey: "gone", taskName: "Dismissed one",
            reviewLifecycle: { ...waitingLifecycle, dismissedAt: 5 } }),
        ]}
        onOpenSession={() => {}}
      />,
    );
    // Default (Open) hides the dismissed session.
    expect(screen.queryByText("Dismissed one")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Dismissed" }));
    expect(screen.getByText("Dismissed one")).toBeInTheDocument();
    expect(screen.queryByText("Open one")).not.toBeInTheDocument();
  });

  it("opens the session from a triage row's primary action", () => {
    const onOpenSession = vi.fn();
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "wait", taskName: "Answer me", status: "waiting", reviewLifecycle: waitingLifecycle })]}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(onOpenSession).toHaveBeenCalledWith("wait");
  });

  it("sends acknowledge and dismiss commands from the triage lane", () => {
    const send = vi.fn();
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "wait", taskName: "Answer me", status: "waiting", reviewLifecycle: waitingLifecycle })]}
        onOpenSession={() => {}}
        send={send}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "acknowledge_session",
      sessionKey: "wait",
      expectedLifecycleRevision: 3,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "dismiss_session",
      sessionKey: "wait",
    }));
  });

  it("omits triage lifecycle actions when no send handler is provided", () => {
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "wait", taskName: "Answer me", status: "waiting", reviewLifecycle: waitingLifecycle })]}
        onOpenSession={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("resolves a core-list card inline via its dismiss action", () => {
    const send = vi.fn();
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Busy card" })]}
        onOpenSession={() => {}}
        send={send}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "dismiss_session",
      sessionKey: "run",
    }));
  });

  it("restores a dismissed session from the core list", () => {
    const send = vi.fn();
    render(
      <ActivityScreen
        sessions={[session({ sessionKey: "gone", taskName: "Dismissed one",
          reviewLifecycle: { ...waitingLifecycle, dismissedAt: 5 } })]}
        onOpenSession={() => {}}
        send={send}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Dismissed" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "reopen_session",
      sessionKey: "gone",
    }));
  });

  it("dismisses multiple selected sessions from the bulk action bar", () => {
    const send = vi.fn();
    render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "a", status: "running", taskName: "One" }),
          session({ sessionKey: "b", status: "running", taskName: "Two" }),
        ]}
        onOpenSession={() => {}}
        send={send}
      />,
    );
    fireEvent.click(screen.getByLabelText("Select One"));
    fireEvent.click(screen.getByLabelText("Select Two"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 2" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "dismiss_session", sessionKey: "a" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "dismiss_session", sessionKey: "b" }));
  });

  it("selects all visible sessions and marks only the reviewable ones", () => {
    const send = vi.fn();
    render(
      <ActivityScreen
        sessions={[
          session({ sessionKey: "wait", status: "waiting", taskName: "Answer me", reviewLifecycle: waitingLifecycle }),
          session({ sessionKey: "run", status: "running", taskName: "Busy" }),
        ]}
        onOpenSession={() => {}}
        send={send}
      />,
    );
    fireEvent.click(screen.getByLabelText("Select Answer me"));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark 1 reviewed" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "acknowledge_session",
      sessionKey: "wait",
      expectedLifecycleRevision: 3,
    }));
  });
});
