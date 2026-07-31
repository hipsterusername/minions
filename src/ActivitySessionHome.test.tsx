import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ActivitySessionHome,
  selectRelevantSessions,
} from "./ActivitySessionHome.tsx";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: overrides.status ?? "idle",
    cwd: "/tmp/project",
    ...overrides,
  };
}

describe("selectRelevantSessions", () => {
  it("prioritizes required decisions, review work, live work, then recency", () => {
    const ranked = selectRelevantSessions([
      session({ sessionKey: "recent", taskName: "Recent idle", lastActivityAt: 900 }),
      session({ sessionKey: "running", taskName: "Running", status: "running", lastActivityAt: 100 }),
      session({
        sessionKey: "review",
        taskName: "Review",
        status: "completed",
        reviewLifecycle: {
          reviewState: "completion_to_review",
          reviewReason: null,
          finalReport: null,
          finalDashboardRevision: null,
          dashboardRevision: 0,
          terminalReason: "completed",
          terminalAt: 200,
          acknowledgedAt: null,
          dismissedAt: null,
          lifecycleRevision: 1,
        },
      }),
      session({
        sessionKey: "decision",
        taskName: "Decision",
        status: "waiting",
        reviewLifecycle: {
          reviewState: "decision_needed",
          reviewReason: "Choose a migration strategy",
          finalReport: null,
          finalDashboardRevision: null,
          dashboardRevision: 0,
          terminalReason: null,
          terminalAt: null,
          acknowledgedAt: null,
          dismissedAt: null,
          lifecycleRevision: 2,
        },
      }),
    ]);

    expect(ranked.map((entry) => entry.sessionKey)).toEqual([
      "decision",
      "review",
      "running",
      "recent",
    ]);
  });

  it("does not keep acknowledged review work ahead of active work", () => {
    const acknowledged = session({
      sessionKey: "acknowledged",
      status: "completed",
      reviewLifecycle: {
        reviewState: "completion_to_review",
        reviewReason: null,
        finalReport: "Already reviewed.",
        finalDashboardRevision: null,
        dashboardRevision: 0,
        terminalReason: "completed",
        terminalAt: 500,
        acknowledgedAt: 600,
        dismissedAt: null,
        lifecycleRevision: 3,
      },
    });
    const running = session({ sessionKey: "running", status: "running", lastActivityAt: 10 });

    expect(selectRelevantSessions([acknowledged, running])[0]?.sessionKey).toBe("running");
  });
});

describe("ActivitySessionHome", () => {
  it("labels an interrupted inactive work item by its current status", () => {
    render(
      <ActivitySessionHome
        sessions={[session({
          sessionKey: "inactive",
          taskName: "Paused work",
          status: "inactive",
          lastActivity: "Inactive",
          reviewLifecycle: {
            reviewState: "interrupted_to_review",
            reviewReason: "Inactive",
            finalReport: null,
            finalDashboardRevision: null,
            dashboardRevision: 0,
            terminalReason: "abort",
            terminalAt: 10,
            acknowledgedAt: null,
            dismissedAt: null,
            lifecycleRevision: 1,
          },
        })]}
        onOpenSession={() => {}}
        onLaunch={() => {}}
      />,
    );

    const feature = document.querySelector(".act-session-feature");
    expect(feature).toHaveClass("act-session-feature--inactive");
    expect(feature).not.toHaveClass("act-session-feature--error");
    expect(screen.getAllByText("Inactive")).not.toHaveLength(0);
    expect(screen.queryByText("Interrupted")).not.toBeInTheDocument();
  });

  it("opens the best next session and keeps new work available", () => {
    const onOpenSession = vi.fn();
    const onLaunch = vi.fn();
    render(
      <ActivitySessionHome
        sessions={[
          session({
            sessionKey: "waiting",
            taskName: "Release decision",
            status: "waiting",
            lastActivity: "Choose whether to ship the compatibility layer.",
          }),
          session({
            sessionKey: "running",
            taskName: "Audit dependencies",
            status: "running",
            lastActivity: "Checking production licenses.",
          }),
        ]}
        onOpenSession={onOpenSession}
        onLaunch={onLaunch}
      />,
    );

    const dashboard = screen.getByRole("main", { name: /session dashboard/i });
    expect(within(dashboard).queryByText(/select a session/i)).not.toBeInTheDocument();
    expect(within(dashboard).getByRole("heading", { name: "Release decision" })).toBeInTheDocument();
    expect(within(dashboard).getByText("Waiting for you")).toBeInTheDocument();

    fireEvent.click(within(dashboard).getByRole("button", { name: /open session/i }));
    expect(onOpenSession).toHaveBeenCalledWith("waiting");

    fireEvent.click(within(dashboard).getByRole("button", { name: /new leader/i }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it("shows only a short continuation list and opens a secondary session", () => {
    const onOpenSession = vi.fn();
    render(
      <ActivitySessionHome
        sessions={[
          session({ sessionKey: "one", taskName: "One", status: "running", lastActivityAt: 50 }),
          session({ sessionKey: "two", taskName: "Two", status: "idle", lastActivityAt: 40 }),
          session({ sessionKey: "three", taskName: "Three", status: "idle", lastActivityAt: 30 }),
          session({ sessionKey: "four", taskName: "Four", status: "idle", lastActivityAt: 20 }),
          session({ sessionKey: "five", taskName: "Five", status: "idle", lastActivityAt: 10 }),
        ]}
        onOpenSession={onOpenSession}
        onLaunch={() => {}}
      />,
    );

    expect(screen.getByText("1 more in Activity")).toBeInTheDocument();
    expect(screen.queryByText("Five")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /two/i }));
    expect(onOpenSession).toHaveBeenCalledWith("two");
  });
});
