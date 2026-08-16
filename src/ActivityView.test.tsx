import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { act } from "react";

import {
  ActivityView,
  lifecycleActionError,
  selectActivityMinions,
} from "./ActivityView.tsx";
import type { SocketSubscribe } from "./use-socket.ts";
import type { CanvasNode } from "./types.ts";
import type { LeaderData } from "./nodes/leader/types.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import type { DisplayMessage } from "./sdk-messages.ts";

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: overrides.sessionKey ?? "s-1",
    sessionId: null,
    status: overrides.status ?? "idle",
    cwd: "/tmp/project",
    ...overrides,
  };
}

const completeLifecycle = {
  reviewState: "completion_to_review" as const,
  reviewReason: "Read the final report and review the dashboard",
  finalReport: "Implemented the migration and verified all tests.",
  finalDashboardRevision: 2,
  dashboardRevision: 2,
  terminalReason: "completed" as const,
  terminalAt: 10,
  acknowledgedAt: null,
  dismissedAt: null,
  lifecycleRevision: 3,
};

function leaderNode(
  sessionKey: string,
  messages: DisplayMessage[] = [],
  overrides: Partial<LeaderData> = {},
): CanvasNode {
  const data: Partial<LeaderData> = {
    sessionKey,
    status: "running",
    messages,
    streamingText: "",
    totalCost: 0,
    turns: 0,
    ...overrides,
  };
  return {
    id: `node-${sessionKey}`,
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    data,
  };
}

const noop = {
  onLaunchLeader: () => {},
  onCommitLaunchLeader: () => {},
  onCancelLaunchLeader: () => {},
  onOpenInCanvas: () => {},
  onExpandFullscreen: () => {},
  onStopSession: () => {},
  onAttachToCanvas: () => {},
  onUpdateNodeData: () => {},
};

function activityList(): HTMLElement {
  const list = document.querySelector<HTMLElement>(".act-main");
  if (!list) throw new Error("Activity list did not render");
  return list;
}

describe("ActivityView", () => {
  it("uses the canvas task plan as the canonical 1:1 minion roster", () => {
    const leader = session({
      sessionKey: "leader-with-stale-roster",
      role: "leader",
      activeMinions: [{
        taskId: "running-only",
        title: "Running only",
        status: "running",
        sessionKey: "minion-running",
      }],
    });
    const canvasPlan: LeaderData["taskPlan"] = [
      {
        taskId: "running-only",
        title: "Running only",
        description: "",
        priority: "high",
        status: "running",
        executor: "minion",
        minionSessionKey: "minion-running",
        result: null,
        cost: 0,
        createdAt: 1,
        completedAt: null,
        sessionSummary: "",
      },
      {
        taskId: "completed-minion",
        title: "Completed minion",
        description: "",
        priority: "medium",
        status: "completed",
        executor: "minion",
        minionSessionKey: "minion-completed",
        result: "done",
        cost: 0,
        createdAt: 2,
        completedAt: 3,
        sessionSummary: "",
      },
      {
        taskId: "leader-work",
        title: "Leader work",
        description: "",
        priority: "low",
        status: "planned",
        executor: "leader",
        minionSessionKey: null,
        result: null,
        cost: 0,
        createdAt: 4,
        completedAt: null,
        sessionSummary: "",
      },
    ];

    expect(selectActivityMinions(leader, canvasPlan).map((minion) => minion.taskId))
      .toEqual(["running-only", "completed-minion"]);

    render(
      <ActivityView
        sessions={[leader]}
        nodes={[leaderNode(leader.sessionKey, [], { taskPlan: canvasPlan })]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /leader-with-stale-roster/i }));
    const inspector = screen.getByRole("complementary", { name: /session details/i });
    expect(within(inspector).getByRole("tab", { name: /minions2/i }))
      .toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByText("Running only")).toBeInTheDocument();
    const completedMinion = within(inspector).getByText("Completed minion").closest(".act-minion-row");
    expect(completedMinion).toHaveAttribute("data-tone", "completed");
    expect(within(inspector).queryByText("Leader work")).not.toBeInTheDocument();
  });

  it("opens on a relevance-first session dashboard instead of an instruction", () => {
    const onLaunchLeader = vi.fn();
    render(
      <ActivityView
        sessions={[
          session({
            sessionKey: "current",
            taskName: "Continue the release",
            status: "running",
            lastActivity: "The build is green and the release checklist is ready.",
          }),
        ]}
        nodes={[]}
        {...noop}
        onLaunchLeader={onLaunchLeader}
      />,
    );

    const dashboard = screen.getByRole("main", { name: /session dashboard/i });
    expect(within(dashboard).getByText("Best next step")).toBeInTheDocument();
    expect(within(dashboard).getByRole("heading", { name: "Continue the release" }))
      .toBeInTheDocument();
    expect(within(dashboard).queryByText(/select a session/i)).not.toBeInTheDocument();

    fireEvent.click(within(dashboard).getByRole("button", { name: /open session/i }));
    expect(screen.getByRole("complementary", { name: /session details/i }))
      .toHaveTextContent("Continue the release");
  });

  it("shows all non-dismissed sessions by default and exposes history filters", () => {
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "open", taskName: "Open work", reviewLifecycle: completeLifecycle }),
          session({
            sessionKey: "dismissed",
            taskName: "Dismissed work",
            reviewLifecycle: { ...completeLifecycle, dismissedAt: 20 },
          }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );
    expect(screen.getByRole("button", { name: /open work/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismissed work/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^dismissed$/i }));
    expect(screen.getByRole("button", { name: /dismissed work/i })).toBeInTheDocument();
  });

  it("shows an interrupted inactive work item as inactive", () => {
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    render(
      <ActivityView
        sessions={[session({
          sessionKey: "inactive-run",
          taskName: "Inactive work",
          status: "inactive",
          lastActivity: "Inactive",
          reviewLifecycle: {
            ...completeLifecycle,
            reviewState: "interrupted_to_review",
            reviewReason: "Inactive",
            finalReport: null,
            terminalReason: "abort",
          },
        })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
        onDetachFromCanvas={onDetachFromCanvas}
      />,
    );

    const list = activityList();
    const row = within(list).getByText("Inactive work").closest(".act-triage-row") as HTMLElement;
    expect(row).toHaveClass("act-triage-row--inactive");
    expect(row).not.toHaveClass("act-triage-row--error");
    expect(within(list).getAllByText(/inactive/i).length).toBeGreaterThan(0);
    expect(within(list).queryByText(/interrupted/i)).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "View" })).not.toBeInTheDocument();

    fireEvent.click(within(row).getByText("Inactive work").closest("button")!);
    const inspector = screen.getByRole("complementary", { name: /session details/i });
    expect(within(inspector).getByText(
      "Review keeps this work in Activity. Review & remove clears it from Activity and detaches it from Canvas.",
    )).toBeInTheDocument();
    const inspectorReview = within(inspector).getByRole("button", { name: "Review" });
    const inspectorRemove = within(inspector).getByRole("button", {
      name: "Review and remove from Activity",
    });
    expect(inspectorReview).toHaveTextContent("");
    expect(inspectorReview.querySelector("svg")).toBeInTheDocument();
    expect(inspectorRemove).toHaveTextContent("");
    expect(inspectorRemove.querySelector(".lucide-list-x")).toBeInTheDocument();

    const rowReview = within(row).getByRole("button", { name: "Review" });
    const rowRemove = within(row).getByRole("button", {
      name: "Review and remove from Activity",
    });
    expect(rowReview).toHaveTextContent("");
    expect(rowRemove).toHaveTextContent("");

    fireEvent.click(rowReview);
    expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "acknowledge_session",
      sessionKey: "inactive-run",
    }));
    expect(onDetachFromCanvas).not.toHaveBeenCalled();

    fireEvent.click(rowRemove);
    expect(onDetachFromCanvas).toHaveBeenCalledWith({
      sessionKey: "inactive-run",
    });
    expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "dismiss_session",
      sessionKey: "inactive-run",
    }));
  });

  it("dismisses a non-canonical work-item session via the session envelope", () => {
    // Regression: a session referencing a work item whose canonical snapshot
    // is not loaded (legacy-migrated item under a stale projectId) carries the
    // SESSION's lifecycle revision. Routing it to archive_work_item made the
    // server reject the click with "stale work-item lifecycle" — it must use
    // dismiss_session, which resolves fresh work-item state server-side.
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[session({
          sessionKey: "leader-new",
          workItemId: "legacy-work-1",
          taskName: "hi",
          reviewLifecycle: completeLifecycle,
        })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
      />,
    );
    const row = within(activityList()).getByText("hi").closest(".act-triage-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^dismiss$/i }));
    expect(socketSend).toHaveBeenCalledWith({
      type: "dismiss_session",
      sessionKey: "leader-new",
      expectedLifecycleRevision: 3,
    });
    expect(socketSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "archive_work_item" }),
    );
  });

  it("detaches a completed session from Canvas when it is dismissed", () => {
    const socketSend = vi.fn();
    const onDetachFromCanvas = vi.fn();
    render(
      <ActivityView
        sessions={[session({
          sessionKey: "completed-run",
          workItemId: "work-1",
          canonicalWorkItem: true,
          taskName: "Completed work",
          reviewLifecycle: completeLifecycle,
        })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
        onDetachFromCanvas={onDetachFromCanvas}
      />,
    );

    const row = within(activityList()).getByText("Completed work")
      .closest(".act-triage-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Dismiss" }));

    expect(onDetachFromCanvas).toHaveBeenCalledWith({
      sessionKey: "completed-run",
      workItemId: "work-1",
    });
    expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "archive_work_item",
      workItemId: "work-1",
    }));
  });

  it("removes a session from Open after the server confirms dismissal", () => {
    const { rerender } = render(
      <ActivityView
        sessions={[session({ sessionKey: "done", taskName: "Dismiss this", reviewLifecycle: completeLifecycle })]}
        nodes={[]}
        {...noop}
      />,
    );
    expect(screen.getByRole("button", { name: /dismiss this/i })).toBeInTheDocument();
    rerender(
      <ActivityView
        sessions={[session({
          sessionKey: "done",
          taskName: "Dismiss this",
          reviewLifecycle: { ...completeLifecycle, dismissedAt: 30, lifecycleRevision: 4 },
        })]}
        nodes={[]}
        {...noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /dismiss this/i })).not.toBeInTheDocument();
  });

  it("shows the persisted final report and sends revisioned review commands", () => {
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "done", taskName: "Finished task", reviewLifecycle: completeLifecycle })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /finished task/i }));
    expect(screen.getByText(/implemented the migration/i)).toBeInTheDocument();
    const inspector = screen.getByRole("complementary", { name: /session details/i });
    fireEvent.click(within(inspector).getByRole("button", { name: /mark reviewed/i }));
    expect(socketSend).toHaveBeenCalledWith({
      type: "acknowledge_session",
      sessionKey: "done",
      expectedLifecycleRevision: 3,
    });
    fireEvent.click(within(inspector).getByRole("button", { name: /^dismiss$/i }));
    expect(socketSend).toHaveBeenCalledWith({
      type: "dismiss_session",
      sessionKey: "done",
      expectedLifecycleRevision: 3,
    });
  });

  it("resolves an individual session inline from the list without opening the inspector", () => {
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "done", taskName: "Finished task", reviewLifecycle: completeLifecycle })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
      />,
    );

    // No inspector is open — the session sits in the Needs you triage lane.
    expect(screen.queryByRole("complementary", { name: /session details/i })).not.toBeInTheDocument();
    const row = within(activityList()).getByText("Finished task")
      .closest(".act-triage-row") as HTMLElement;
    const primaryAction = within(row).getByRole("button", { name: /^read$/i });
    const reviewAction = within(row).getByRole("button", { name: /mark reviewed/i });
    const dismissAction = within(row).getByRole("button", { name: /^dismiss$/i });
    expect(primaryAction).toHaveClass("act-mini-btn--primary");
    expect(reviewAction.querySelector("svg")).not.toBeNull();
    expect(reviewAction.textContent).toBe("");
    expect(dismissAction.querySelector("svg")).not.toBeNull();
    expect(dismissAction.textContent).toBe("");

    fireEvent.click(reviewAction);
    expect(socketSend).toHaveBeenCalledWith({
      type: "acknowledge_session",
      sessionKey: "done",
      expectedLifecycleRevision: 3,
    });
    // Still no inspector — the action was immediate.
    expect(screen.queryByRole("complementary", { name: /session details/i })).not.toBeInTheDocument();

    fireEvent.click(dismissAction);
    expect(socketSend).toHaveBeenCalledWith({
      type: "dismiss_session",
      sessionKey: "done",
      expectedLifecycleRevision: 3,
    });
  });

  describe("on a non-secure origin (no crypto.randomUUID)", () => {
    const UUID_V4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const originalCrypto = globalThis.crypto;

    afterEach(() => {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    });

    /** Simulate http://<lan-ip>: getRandomValues exists, randomUUID does not. */
    function stubInsecureCrypto() {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: {
          getRandomValues<T extends ArrayBufferView>(array: T): T {
            const bytes = new Uint8Array(
              array.buffer,
              array.byteOffset,
              array.byteLength,
            );
            for (let i = 0; i < bytes.length; i += 1) {
              bytes[i] = Math.floor(Math.random() * 256);
            }
            return array;
          },
        },
      });
    }

    it("still resolves a work-item session from the triage lane", () => {
      // Regression: sendLifecycle minted its requestId with crypto.randomUUID(),
      // which throws on non-secure origins — every Check/X click was a silent
      // no-op and the command never reached the socket.
      stubInsecureCrypto();
      const socketSend = vi.fn();
      render(
        <ActivityView
          sessions={[session({
            sessionKey: "run-1",
            workItemId: "work-1",
            canonicalWorkItem: true,
            taskName: "Canonical done",
            reviewLifecycle: completeLifecycle,
          })]}
          nodes={[]}
          {...noop}
          socketSend={socketSend}
        />,
      );

      const row = within(activityList()).getByText("Canonical done")
        .closest(".act-triage-row") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: /mark reviewed/i }));
      expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({
        type: "review_work_item",
        workItemId: "work-1",
        expectedLifecycleRevision: 3,
        expectedCurrentRunKey: "run-1",
        requestId: expect.stringMatching(UUID_V4),
      }));

      fireEvent.click(within(row).getByRole("button", { name: /^dismiss$/i }));
      expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({
        type: "archive_work_item",
        workItemId: "work-1",
        requestId: expect.stringMatching(UUID_V4),
      }));
    });

    it("still bulk-dismisses selected sessions", () => {
      stubInsecureCrypto();
      const socketSend = vi.fn();
      render(
        <ActivityView
          sessions={[
            session({ sessionKey: "a", status: "idle", taskName: "First idle" }),
            session({ sessionKey: "b", status: "idle", taskName: "Second idle" }),
          ]}
          nodes={[]}
          {...noop}
          socketSend={socketSend}
        />,
      );

      fireEvent.click(screen.getByRole("checkbox", { name: /select first idle/i }));
      fireEvent.click(screen.getByRole("checkbox", { name: /select second idle/i }));
      const bulk = screen.getByRole("toolbar", { name: /bulk actions/i });
      fireEvent.click(within(bulk).getByRole("button", { name: /dismiss 2/i }));

      expect(socketSend).toHaveBeenCalledTimes(2);
      expect(socketSend).toHaveBeenCalledWith({
        type: "dismiss_session",
        sessionKey: "a",
        expectedLifecycleRevision: 0,
      });
      expect(socketSend).toHaveBeenCalledWith({
        type: "dismiss_session",
        sessionKey: "b",
        expectedLifecycleRevision: 0,
      });
    });
  });

  it("dismisses multiple sessions at once from the bulk action bar", () => {
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "a", status: "idle", taskName: "First idle" }),
          session({ sessionKey: "b", status: "idle", taskName: "Second idle" }),
          session({ sessionKey: "c", status: "idle", taskName: "Third idle" }),
        ]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /select first idle/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /select second idle/i }));

    const bulk = screen.getByRole("toolbar", { name: /bulk actions/i });
    expect(within(bulk).getByText(/2 selected/i)).toBeInTheDocument();
    fireEvent.click(within(bulk).getByRole("button", { name: /dismiss 2/i }));

    expect(socketSend).toHaveBeenCalledTimes(2);
    expect(socketSend).toHaveBeenCalledWith({
      type: "dismiss_session",
      sessionKey: "a",
      expectedLifecycleRevision: 0,
    });
    expect(socketSend).toHaveBeenCalledWith({
      type: "dismiss_session",
      sessionKey: "b",
      expectedLifecycleRevision: 0,
    });
    // Selection clears after the bulk action, hiding the toolbar.
    expect(screen.queryByRole("toolbar", { name: /bulk actions/i })).not.toBeInTheDocument();
  });

  it("selects every visible session from the bulk bar and marks them reviewed", () => {
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "r1", taskName: "Review one", reviewLifecycle: completeLifecycle }),
          session({ sessionKey: "r2", taskName: "Review two", reviewLifecycle: completeLifecycle }),
        ]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /select review one/i }));
    const bulk = screen.getByRole("toolbar", { name: /bulk actions/i });
    fireEvent.click(within(bulk).getByRole("button", { name: /select all/i }));
    expect(within(bulk).getByText(/2 selected/i)).toBeInTheDocument();

    fireEvent.click(within(bulk).getByRole("button", { name: /mark 2 reviewed/i }));
    expect(socketSend).toHaveBeenCalledTimes(2);
    expect(socketSend).toHaveBeenCalledWith({
      type: "acknowledge_session",
      sessionKey: "r1",
      expectedLifecycleRevision: 3,
    });
    expect(socketSend).toHaveBeenCalledWith({
      type: "acknowledge_session",
      sessionKey: "r2",
      expectedLifecycleRevision: 3,
    });
  });

  it("presents count-free bulk actions side by side with the individual-card icons", () => {
    render(
      <ActivityView
        sessions={[
          session({
            sessionKey: "retained",
            taskName: "Interrupted work",
            status: "inactive",
            reviewLifecycle: {
              ...completeLifecycle,
              reviewState: "interrupted_to_review",
              acknowledgedAt: null,
              dismissedAt: null,
            },
          }),
          session({ sessionKey: "open", taskName: "Open work" }),
          session({
            sessionKey: "dismissed",
            taskName: "Dismissed work",
            reviewLifecycle: { ...completeLifecycle, dismissedAt: 20 },
          }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /select interrupted work/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /select open work/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /select dismissed work/i }));

    const bulk = screen.getByRole("toolbar", { name: /bulk actions/i });
    const actions = within(bulk).getByRole("group", { name: /selected activity actions/i });
    const review = within(actions).getByRole("button", { name: /^review 1$/i });
    const remove = within(actions).getByRole("button", {
      name: /review and remove 1 from activity/i,
    });
    const dismiss = within(actions).getByRole("button", { name: /^dismiss 1$/i });
    const restore = within(actions).getByRole("button", { name: /^restore 1$/i });

    expect(review).toHaveTextContent("Review and keep in Activity");
    expect(review.querySelector(".lucide-check")).toBeInTheDocument();
    expect(remove).toHaveTextContent("Review and remove");
    expect(remove.querySelector(".lucide-list-x")).toBeInTheDocument();
    expect(dismiss).toHaveTextContent("Dismiss");
    expect(dismiss.querySelector(".lucide-x")).toBeInTheDocument();
    expect(restore).toHaveTextContent("Restore");
    expect(restore.querySelector(".lucide-rotate-ccw")).toBeInTheDocument();
    expect(actions.querySelector("strong")).not.toBeInTheDocument();
    expect(actions).toHaveClass("act-bulk-actions");
    expect(within(bulk).getByRole("button", { name: /clear selection/i })).toBeInTheDocument();
  });

  describe("lifecycle action failures", () => {
    function makeSubscribe() {
      const handlers: Array<(msg: unknown) => void> = [];
      const subscribe = Object.assign(
        ((...args: unknown[]) => {
          const fn = (args.length === 1 ? args[0] : args[1]) as (msg: unknown) => void;
          handlers.push(fn);
          return () => {};
        }) as SocketSubscribe,
        { supportsTopics: true as const },
      );
      return {
        subscribe,
        emit: (msg: unknown) => act(() => handlers.forEach((handler) => handler(msg))),
      };
    }

    it("surfaces a rejected lifecycle command and clears it on later success", () => {
      const { subscribe, emit } = makeSubscribe();
      render(
        <ActivityView
          sessions={[session({ sessionKey: "done", taskName: "Finished task", reviewLifecycle: completeLifecycle })]}
          nodes={[]}
          {...noop}
          socketSend={vi.fn()}
          socketSubscribe={subscribe}
        />,
      );

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      emit({
        type: "work_item_response",
        command: "archive_work_item",
        requestId: "r-1",
        success: false,
        error: "Lifecycle revision conflict",
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        /dismiss failed: lifecycle revision conflict/i,
      );

      // A later successful lifecycle response clears the stale banner.
      emit({
        type: "work_item_response",
        command: "archive_work_item",
        requestId: "r-2",
        success: true,
        result: {},
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("surfaces control_response failures and supports manual dismissal", () => {
      const { subscribe, emit } = makeSubscribe();
      render(
        <ActivityView
          sessions={[session({ sessionKey: "done", taskName: "Finished task", reviewLifecycle: completeLifecycle })]}
          nodes={[]}
          {...noop}
          socketSend={vi.fn()}
          socketSubscribe={subscribe}
        />,
      );

      emit({
        type: "control_response",
        command: "acknowledge_session",
        sessionKey: "done",
        requestId: null,
        success: false,
        error: "Session done not found",
      });
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/mark reviewed failed: session done not found/i);

      fireEvent.click(within(alert).getByRole("button", { name: /dismiss error/i }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("ignores unrelated responses", () => {
      expect(lifecycleActionError({ type: "work_item_response", command: "list_work_items", success: false })).toBeNull();
      expect(lifecycleActionError({ type: "control_response", command: "stop_task", success: false })).toBeNull();
      expect(lifecycleActionError({ type: "sdk_event" })).toBeNull();
      expect(lifecycleActionError({
        type: "control_response", command: "dismiss_session", success: false,
      })).toEqual({ failed: true, error: "Dismiss failed: The server rejected the action." });
    });
  });

  it("shows an optimistic user turn and thinking state while steering a selected session", () => {
    const socketSend = vi.fn();
    const listeners = new Set<(message: unknown) => void>();
    const socketSubscribe = ((
      topicOrListener: string | ((message: unknown) => void),
      maybeListener?: (message: unknown) => void,
    ) => {
      const listener = typeof topicOrListener === "function"
        ? topicOrListener
        : maybeListener!;
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as SocketSubscribe;
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Working" })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
      />,
    );
    fireEvent.click(within(activityList()).getByText("Working").closest("button")!);
    const composer = screen.getByRole("textbox", { name: /reply or steer/i });
    expect(composer).toHaveAttribute("rows", "3");
    fireEvent.change(composer, {
      target: { value: "Use the safer migration." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(socketSend).toHaveBeenCalledWith({
      type: "send_message",
      sessionKey: "run",
      prompt: "Use the safer migration.",
      displayPrompt: "Use the safer migration.",
    });
    expect(screen.getByText("Use the safer migration.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Leader is thinking…");

    act(() => {
      for (const listener of listeners) {
        listener({
          type: "sdk_event",
          sessionKey: "run",
          event: { kind: "text", role: "user", text: "Use the safer migration.", id: "server-user" },
        });
      }
    });
    expect(screen.getAllByText("Use the safer migration.")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Leader is thinking…");

    act(() => {
      for (const listener of listeners) {
        listener({
          type: "sdk_event",
          sessionKey: "run",
          event: { kind: "text", role: "assistant", text: "I’ll apply that migration." },
        });
      }
    });
    expect(screen.getByText("I’ll apply that migration.")).toBeInTheDocument();
    expect(screen.queryByText("Leader is thinking…")).not.toBeInTheDocument();
  });

  it("starts a new iteration for a non-canonical work-item session via send_message", () => {
    const socketSend = vi.fn();
    const onPromptWorkItem = vi.fn();
    const props = {
      nodes: [],
      ...noop,
      socketSend,
      onPromptWorkItem,
    };
    const { rerender } = render(
      <ActivityView
        sessions={[session({
          sessionKey: "existing-agent",
          workItemId: "unloaded-work-item",
          canonicalWorkItem: false,
          status: "inactive",
          taskName: "Existing agent",
        })]}
        {...props}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /existing agent/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /reply or steer/i }), {
      target: { value: "Start another iteration." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(socketSend).toHaveBeenCalledWith({
      type: "send_message",
      sessionKey: "existing-agent",
      prompt: "Start another iteration.",
      displayPrompt: "Start another iteration.",
    });
    expect(onPromptWorkItem).not.toHaveBeenCalled();

    rerender(
      <ActivityView
        sessions={[session({
          sessionKey: "next-iteration",
          workItemId: "unloaded-work-item",
          canonicalWorkItem: true,
          status: "running",
          taskName: "Existing agent",
        })]}
        {...props}
      />,
    );

    expect(screen.getByRole("button", { name: /existing agent/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("complementary", { name: /session details/i }))
      .toHaveTextContent("Existing agent");
  });

  it("routes canonical initiation through the conflict-recovering work-item client", () => {
    const socketSend = vi.fn();
    const onPromptWorkItem = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run-1", workItemId: "work-1",
          canonicalWorkItem: true, status: "inactive", taskName: "Completed",
          reviewLifecycle: completeLifecycle })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
        onPromptWorkItem={onPromptWorkItem}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /completed/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /reply or steer/i }), {
      target: { value: "Start the next iteration." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(onPromptWorkItem).toHaveBeenCalledWith("work-1", "Start the next iteration.");
    expect(socketSend).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "start_work_item_run",
    }));
  });

  it("restores a terminally failed canonical prompt and shows its error inline", async () => {
    const sessionRow = session({ sessionKey: "run-1", workItemId: "work-1",
      canonicalWorkItem: true, status: "inactive", taskName: "Completed",
      reviewLifecycle: completeLifecycle });
    const onPromptWorkItem = vi.fn();
    const onClearPromptFailure = vi.fn();
    const props = {
      sessions: [sessionRow], nodes: [], ...noop, socketSend: vi.fn(),
      onPromptWorkItem, onClearPromptFailure,
    };
    const { rerender } = render(<ActivityView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /completed/i }));
    const composer = screen.getByRole("textbox", { name: /reply or steer/i });
    fireEvent.change(composer, { target: { value: "Do not lose this." } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(composer).toHaveValue("");

    rerender(<ActivityView {...props} promptFailures={{
      "work-1": { prompt: "Do not lose this.", error: "Harness unavailable" },
    }} />);

    await waitFor(() => expect(composer).toHaveValue("Do not lose this."));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/harness unavailable/i);
    fireEvent.click(within(alert).getByRole("button", { name: /dismiss prompt error/i }));
    expect(onClearPromptFailure).toHaveBeenCalledWith("work-1");
    expect(composer).toHaveValue("Do not lose this.");
  });

  it("offers a New action from the activity header", () => {
    const onLaunchLeader = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Working" })]}
        nodes={[]}
        {...noop}
        onLaunchLeader={onLaunchLeader}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(onLaunchLeader).toHaveBeenCalledTimes(1);
  });

  it("commits an Activity leader to Canvas only after its session is initiated", () => {
    const draft = leaderNode("", [], { sessionKey: null, status: "disconnected" });
    const onCommitLaunchLeader = vi.fn();
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Working" })]}
        nodes={[]}
        {...noop}
        onLaunchLeader={() => draft}
        onCommitLaunchLeader={onCommitLaunchLeader}
        socketSend={socketSend}
        projectPath="/tmp/project"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(onCommitLaunchLeader).not.toHaveBeenCalled();

    const launchPanel = screen.getByRole("region", { name: /new leader/i });
    fireEvent.click(within(launchPanel).getByRole("checkbox", { name: /isolated worktree/i }));
    expect(onCommitLaunchLeader).not.toHaveBeenCalled();
    fireEvent.change(within(launchPanel).getByRole("textbox", { name: /leader prompt/i }), {
      target: { value: "Start only when submitted." },
    });
    fireEvent.click(within(launchPanel).getByRole("button", { name: /^launch leader$/i }));

    expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "create_session",
      role: "leader",
      prompt: "Start only when submitted.",
    }));
    expect(onCommitLaunchLeader).toHaveBeenCalledTimes(1);
    expect(onCommitLaunchLeader).toHaveBeenCalledWith(expect.objectContaining({
      id: draft.id,
      data: expect.objectContaining({
        sessionKey: expect.stringMatching(/^leader-/),
        worktreeIsolation: true,
      }),
    }));
  });

  it("auto-opens a compact launch composer with settings available in one panel", () => {
    const draft = leaderNode("", [], { sessionKey: null, status: "disconnected" });
    const onUpdateNodeData = vi.fn();
    render(
      <ActivityView
        sessions={[]}
        nodes={[draft]}
        {...noop}
        onLaunchLeader={() => draft.id}
        onUpdateNodeData={onUpdateNodeData}
        projectPath="/tmp/project"
      />,
    );

    // The empty state embeds the full composer with zero extra clicks.
    expect(screen.getByRole("region", { name: /add an agent/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Describe your project goal...")).toBeInTheDocument();
    const setup = screen.getByRole("complementary", { name: /run setup/i });
    expect(setup.querySelector("details")).toBeNull();
    expect(within(setup).getByText("Run configuration")).toBeVisible();
    expect(within(setup).getByLabelText("Configured settings")).toHaveTextContent(/opus/i);
    expect(within(setup).getByLabelText("Configured settings")).toHaveTextContent(/auto/i);
    expect(within(setup).getByLabelText("Configured settings")).toHaveTextContent(/shared/i);
    expect(within(setup).getByLabelText("Configured settings")).toHaveTextContent(/0 skills/i);
    expect(within(setup).getByRole("combobox", { name: /model/i })).toBeVisible();
    expect(within(setup).getByRole("combobox", { name: /permissions/i })).toBeVisible();
    expect(within(setup).getByRole("checkbox", { name: /isolated worktree/i })).toBeVisible();
    expect(within(setup).getByText("Skills")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new leader form open/i })).toBeDisabled();

    const prompt = screen.getByRole("textbox", { name: "Leader prompt" });
    const promptSurface = prompt.closest(".leader-launch-prompt");
    fireEvent.change(prompt, { target: { value: "/" } });
    const commandMenu = screen.getByRole("listbox", { name: "Leader context shortcuts" });
    expect(promptSurface).not.toContainElement(commandMenu);
    expect(document.body).toContainElement(commandMenu);

    fireEvent.click(within(setup).getByRole("checkbox", { name: /isolated worktree/i }));
    expect(onUpdateNodeData).toHaveBeenLastCalledWith(
      draft.id,
      expect.objectContaining({ worktreeIsolation: true }),
    );
    expect(screen.queryByRole("button", { name: /open on canvas/i })).not.toBeInTheDocument();
  });

  it("lays out first-run guidance like a new leader and keeps it outside the session-list gutter", () => {
    const draft = leaderNode("", [], { sessionKey: null, status: "disconnected" });
    render(
      <ActivityView
        sessions={[]}
        nodes={[draft]}
        {...noop}
        onLaunchLeader={() => draft.id}
      />,
    );

    const onboarding = screen.getByRole("banner", { name: /getting started with minions/i });
    const workspace = screen.getByRole("main", { name: /activity workspace/i });
    const composer = screen.getByRole("region", { name: /add an agent/i });
    const sessionList = document.querySelector(".act-main");

    expect(workspace).toContainElement(onboarding);
    expect(workspace).toContainElement(composer);
    expect(workspace).toHaveClass("act-launch-panel");
    expect(onboarding).toHaveClass("act-launch-head");
    expect(composer.closest(".act-launch-inputs")).toBeInTheDocument();
    expect(sessionList).not.toContainElement(onboarding);
    expect(sessionList).not.toContainElement(composer);
    expect(sessionList).toHaveTextContent("Your leader sessions will appear here");
    expect(onboarding).toHaveTextContent("What should it do?");
    const capabilityGroup = onboarding.querySelector(".act-onboarding__capability-group");
    expect(capabilityGroup?.firstElementChild).toHaveTextContent("You can tell the leader to:");
    expect(capabilityGroup?.lastElementChild).toHaveAttribute("aria-label", "Things a leader can do");
    expect(onboarding).toHaveTextContent("Spawn Minions");
    expect(onboarding).toHaveTextContent("Delegate focused work in parallel");
    expect(onboarding).toHaveTextContent("Display a dashboard");
    expect(onboarding).toHaveTextContent("progress, decisions, or results");
  });

  it("removes an unlaunched draft when the launch workspace is cancelled", () => {
    const draft = leaderNode("", [], { sessionKey: null, status: "disconnected" });
    const onCancelLaunchLeader = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Working" })]}
        nodes={[draft]}
        {...noop}
        onLaunchLeader={() => draft.id}
        onCancelLaunchLeader={onCancelLaunchLeader}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel new leader/i }));

    expect(onCancelLaunchLeader).toHaveBeenCalledWith(draft.id);
    expect(screen.queryByRole("region", { name: /new leader/i })).not.toBeInTheDocument();
  });

  it("launches from the Activity workspace without opening another surface", () => {
    const draft = leaderNode("", [], {
      sessionKey: null,
      status: "disconnected",
      model: "opus",
      permissionMode: "auto",
      thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      worktreeIsolation: false,
      skillIds: [],
      skillValues: {},
    });
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[]}
        nodes={[draft]}
        {...noop}
        onLaunchLeader={() => draft.id}
        socketSend={socketSend}
        projectPath="/tmp/project"
      />,
    );

    const workspace = screen.getByRole("region", { name: /add an agent/i });
    fireEvent.change(within(workspace).getByRole("textbox", { name: /leader prompt/i }), {
      target: { value: "Repair the release workflow and verify it." },
    });
    fireEvent.click(within(workspace).getByRole("button", { name: /^launch leader$/i }));

    expect(socketSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "create_session",
      role: "leader",
      prompt: "Repair the release workflow and verify it.",
      cwd: "/tmp/project",
    }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("selects the newly created leader in Activity when its session appears", () => {
    const draft = leaderNode("", [], { sessionKey: null, status: "disconnected" });
    const props = {
      ...noop,
      onLaunchLeader: () => draft.id,
      projectPath: "/tmp/project",
    };
    const { rerender } = render(<ActivityView sessions={[]} nodes={[draft]} {...props} />);

    expect(screen.getByRole("region", { name: /add an agent/i })).toBeInTheDocument();

    const startedNode = {
      ...leaderNode("leader-new", [], { taskName: "Fresh task", status: "running" }),
      id: draft.id,
    };
    rerender(
      <ActivityView
        sessions={[session({ sessionKey: "leader-new", taskName: "Fresh task", status: "running" })]}
        nodes={[startedNode]}
        {...props}
      />,
    );

    expect(screen.queryByRole("region", { name: /add an agent/i })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /session details/i })).toHaveTextContent("Fresh task");
  });

  it("offers New from the empty activity state when no draft could be created", () => {
    // onLaunchLeader returns void — the auto-open attempt yields no draft, so
    // the empty state falls back to an explicit New CTA.
    const onLaunchLeader = vi.fn();
    render(
      <ActivityView
        sessions={[]}
        nodes={[]}
        {...noop}
        onLaunchLeader={onLaunchLeader}
      />,
    );

    expect(onLaunchLeader).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole("region", { name: /add an agent/i }))
      .getByRole("button", { name: /^new$/i }));
    expect(onLaunchLeader).toHaveBeenCalledTimes(2);
  });

  it("previews recent agent work in the empty state and opens it on the canvas", () => {
    const onOpenInCanvas = vi.fn();
    const messages: DisplayMessage[] = [
      { id: "a1", role: "assistant", content: "Shipped the schema migration.", timestamp: 5 },
    ];
    render(
      <ActivityView
        sessions={[]}
        nodes={[leaderNode("prior", messages, { taskName: "Prior work" })]}
        {...noop}
        onOpenInCanvas={onOpenInCanvas}
      />,
    );

    const recent = screen.getByRole("region", { name: /recent agent work/i });
    const card = within(recent).getByRole("button", { name: /prior work/i });
    expect(card).toHaveTextContent("Shipped the schema migration.");
    fireEvent.click(card);
    expect(onOpenInCanvas).toHaveBeenCalledWith("node-prior");
  });

  it("opens node-less recent work in Activity without attaching it to the canvas", () => {
    const onAttachToCanvas = vi.fn();
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "idle-1", status: "idle", taskName: "Quiet agent", lastActivityAt: 3 }),
        ]}
        nodes={[]}
        {...noop}
        onAttachToCanvas={onAttachToCanvas}
      />,
    );

    // Zero "working" sessions → filtered-empty state with the preview + composer.
    fireEvent.click(screen.getByRole("button", { name: /working: 0\. filter activity/i }));
    expect(screen.getByText("No sessions match this activity filter")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /add an agent/i })).toBeInTheDocument();

    const recent = screen.getByRole("region", { name: /recent agent work/i });
    fireEvent.click(within(recent).getByRole("button", { name: /quiet agent/i }));
    expect(screen.getByRole("complementary", { name: /session details/i }))
      .toHaveTextContent("Quiet agent");
    expect(onAttachToCanvas).not.toHaveBeenCalled();
  });

  it("groups sessions Active → Idle → Stopped and excludes minions from the count", () => {
    const { container } = render(
      <ActivityView
        sessions={[
          session({ sessionKey: "run", status: "running", taskName: "Working", lastActivityAt: 100 }),
          session({ sessionKey: "idle", status: "idle", taskName: "Waiting" }),
          session({ sessionKey: "done", status: "completed", taskName: "Finished" }),
          session({ sessionKey: "m", role: "minion", status: "running", taskName: "Minion" }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Active",
      "Idle",
      "Stopped / Cleared",
    ]);
    expect(screen.queryByText("Minion")).not.toBeInTheDocument();
    expect(container.querySelector(".act-header-count")?.textContent).toBe("3");
  });

  it("makes running and idle cards state-led instead of telemetry-led", () => {
    render(
      <ActivityView
        sessions={[
          session({
            sessionKey: "run",
            role: "leader",
            status: "running",
            taskName: "Dependency audit",
            lastActivity: "Checking production licenses and release constraints.",
            lastActivityAt: Date.now() - 60_000,
            totalCost: 7.25,
            turns: 18,
            model: "internal-debug-model",
            activeMinions: [
              {
                taskId: "licenses",
                title: "Check licenses",
                status: "running",
                sessionKey: "minion-licenses",
              },
              {
                taskId: "docs",
                title: "Read docs",
                status: "planned",
                sessionKey: "minion-docs",
              },
            ],
          }),
          session({
            sessionKey: "idle",
            status: "idle",
            taskName: "Release notes",
          }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    const activeCard = within(screen.getByRole("region", { name: /^active$/i }))
      .getByRole("button", { name: /dependency audit/i });
    expect(activeCard).toHaveTextContent("Working now");
    expect(activeCard).toHaveTextContent("Checking production licenses");
    expect(activeCard).toHaveTextContent("Updated 1m ago");
    expect(activeCard).toHaveTextContent("1 minion working");
    expect(activeCard).not.toHaveTextContent("$7.25");
    expect(activeCard).not.toHaveTextContent("18 turns");
    expect(activeCard).not.toHaveTextContent("internal-debug-model");

    const idleCard = within(screen.getByRole("region", { name: /^idle$/i }))
      .getByRole("button", { name: /release notes/i });
    expect(idleCard).toHaveTextContent("Ready for input");
    expect(idleCard).toHaveTextContent("No recent activity");
    expect(idleCard).not.toHaveTextContent("/tmp/project");
    expect(idleCard).not.toHaveTextContent("idle");
  });

  it("gives completed session cards the success tone", () => {
    render(
      <ActivityView
        sessions={[
          session({
            sessionKey: "done",
            status: "completed",
            taskName: "Release complete",
          }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    const completedCard = within(screen.getByRole("region", { name: /stopped \/ cleared/i }))
      .getByRole("button", { name: /release complete/i })
      .closest(".act-card");
    expect(completedCard).toHaveClass("act-card--completed");
  });

  it("removes generic activity echoes and labels paused work clearly", () => {
    render(
      <ActivityView
        sessions={[
          session({
            sessionKey: "run",
            status: "running",
            taskName: "Live work",
            lastActivity: "Working",
          }),
          session({
            sessionKey: "paused",
            status: "inactive",
            taskName: "Paused work",
            lastActivity: "Inactive",
          }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    const runningCard = within(screen.getByRole("region", { name: /^active$/i }))
      .getByRole("button", { name: /live work/i });
    expect(runningCard.querySelector(".act-card-activity")).toBeNull();

    const pausedCard = within(screen.getByRole("region", { name: /^idle$/i }))
      .getByRole("button", { name: /paused work/i });
    expect(pausedCard).toHaveTextContent("Paused");
    expect(pausedCard.querySelector(".act-card-activity")).toBeNull();
  });

  it("does not repeat the session title as card activity", () => {
    render(
      <ActivityView
        sessions={[
          session({
            sessionKey: "duplicate",
            status: "running",
            taskName: "Release checklist",
            lastActivity: "  release CHECKLIST  ",
          }),
          session({
            sessionKey: "distinct",
            status: "running",
            taskName: "Dependency audit",
            lastActivity: "Checking production licenses",
          }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    const active = screen.getByRole("region", { name: /^active$/i });
    const duplicateCard = within(active)
      .getByText("Release checklist", { selector: ".act-card-title" })
      .closest(".act-card-main")!;
    expect(duplicateCard.querySelector(".act-card-activity")).toBeNull();

    const distinctCard = within(active)
      .getByText("Dependency audit", { selector: ".act-card-title" })
      .closest(".act-card-main")!;
    expect(distinctCard.querySelector(".act-card-activity"))
      .toHaveTextContent("Checking production licenses");
  });

  it("pins errors, waiting sessions, and reviewable changes in Needs you", () => {
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "run", status: "running", taskName: "Running normal" }),
          session({ sessionKey: "err", status: "error", taskName: "Errored task", lastActivityAt: 30 }),
          session({
            sessionKey: "wait",
            status: "waiting",
            taskName: "Needs reply",
            lastActivityAt: 20,
          }),
          session({
            sessionKey: "changes",
            status: "running",
            taskName: "Changes ready",
            lastActivityAt: 10,
          }),
          session({ sessionKey: "idle", status: "idle", taskName: "Idle normal" }),
        ]}
        nodes={[leaderNode("changes", [], { worktreeIsolation: true, worktreeStatus: "active" })]}
        {...noop}
      />,
    );

    expect(screen.getAllByRole("region").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Needs you",
      "Active",
      "Idle",
    ]);

    const needsYou = screen.getByRole("region", { name: /needs you/i });
    expect(within(needsYou).getByRole("button", { name: /errored task/i })).toBeInTheDocument();
    expect(within(needsYou).getByText("errored")).toBeInTheDocument();
    expect(within(needsYou).getByRole("button", { name: /needs reply/i })).toBeInTheDocument();
    expect(within(needsYou).getByText("waiting for you")).toBeInTheDocument();
    expect(within(needsYou).getByRole("button", { name: /changes ready/i })).toBeInTheDocument();

    const active = screen.getByRole("region", { name: /^active$/i });
    expect(within(active).getByRole("button", { name: /running normal/i })).toBeInTheDocument();
    expect(within(active).queryByRole("button", { name: /changes ready/i })).not.toBeInTheDocument();

    fireEvent.click(within(needsYou).getByRole("button", { name: /^review$/i }));
    expect(screen.getByRole("complementary", { name: /session details/i })).toHaveTextContent(
      "Changes ready",
    );
  });

  it("filters from the desktop summary counts and clears the filter on a second click", () => {
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "run", status: "running", taskName: "In progress" }),
          session({ sessionKey: "wait", status: "waiting", taskName: "Needs reply" }),
          session({ sessionKey: "idle", status: "idle", taskName: "Taking a break" }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    const workingFilter = screen.getByRole("button", { name: /working: 1\. filter activity/i });
    fireEvent.click(workingFilter);
    expect(workingFilter).toHaveAttribute("aria-pressed", "true");
    expect(within(activityList()).getByText("In progress")).toBeInTheDocument();
    expect(within(activityList()).queryByText("Needs reply")).not.toBeInTheDocument();
    expect(within(activityList()).queryByText("Taking a break")).not.toBeInTheDocument();

    fireEvent.click(workingFilter);
    expect(workingFilter).toHaveAttribute("aria-pressed", "false");
    expect(within(activityList()).getByText("Needs reply")).toBeInTheDocument();
    expect(within(activityList()).getByText("Taking a break")).toBeInTheDocument();
  });

  it("supports needs-you and waiting summary filters and keeps zero-result controls available", () => {
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "wait", status: "waiting", taskName: "Needs reply" }),
          session({ sessionKey: "idle", status: "idle", taskName: "Taking a break" }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    const reviewFilter = screen.getByRole("button", { name: /to review: 1\. filter activity/i });
    fireEvent.click(reviewFilter);
    expect(within(activityList()).getByText("Needs reply")).toBeInTheDocument();
    expect(within(activityList()).queryByText("Taking a break")).not.toBeInTheDocument();

    const waitingFilter = screen.getByRole("button", { name: /waiting: 1\. filter activity/i });
    fireEvent.click(waitingFilter);
    expect(waitingFilter).toHaveAttribute("aria-pressed", "true");
    expect(within(activityList()).getByText("Needs reply")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(waitingFilter).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: /working: 0\. filter activity/i }));
    expect(screen.getByText("No sessions match this activity filter")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /working: 0\. clear filter/i })).toBeInTheDocument();
  });

  it("opens the inspector with metadata when a card is selected", () => {
    render(
      <ActivityView
        sessions={[
          session({ sessionKey: "run", status: "running", taskName: "Ship it", totalCost: 1.5, turns: 7, model: "claude-opus-4-8" }),
        ]}
        nodes={[]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /ship it/i }));
    const inspector = screen.getByRole("complementary", { name: /session details/i });
    expect(within(inspector).getByText("$1.50")).toBeInTheDocument();
    expect(within(inspector).getByText("7")).toBeInTheDocument();
    expect(within(inspector).getByText("claude-opus-4-8")).toBeInTheDocument();
  });

  it("keeps conversation visible while switching the supporting context tabs", () => {
    const messages: DisplayMessage[] = [
      { id: "u1", role: "user", content: "Keep the migration safe.", timestamp: 1 },
      { id: "a1", role: "assistant", content: "I am verifying each step.", timestamp: 2 },
    ];
    render(
      <ActivityView
        sessions={[session({
          sessionKey: "done",
          status: "idle",
          role: "leader",
          taskName: "Review the release",
          reviewLifecycle: completeLifecycle,
          activeMinions: [{
            taskId: "verify-release",
            title: "Verify release",
            status: "running",
            sessionKey: "minion-1",
          }],
          renderState: {
            layout: { title: "Release status", columns: 1 },
            components: [{ id: "status", type: "text", content: "Dashboard online" }],
          },
        })]}
        nodes={[leaderNode("done", messages)]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /review the release/i }));
    const inspector = screen.getByRole("complementary", { name: /session details/i });
    const conversation = within(inspector).getByRole("main", { name: /^conversation$/i });
    const tabs = within(inspector).getByRole("tablist", { name: /leader context views/i });
    expect(within(inspector).queryByText("History and steering")).not.toBeInTheDocument();
    expect(within(inspector).queryByText(/complete transcript stays in view/i))
      .not.toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /dashboard/i }))
      .toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByText("Dashboard online")).toBeInTheDocument();
    expect(within(conversation).getByText("Keep the migration safe.")).toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole("tab", { name: /minions/i }));
    expect(within(inspector).getByText("Verify release")).toBeInTheDocument();
    expect(within(conversation).getByText("I am verifying each step.")).toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole("tab", { name: /session/i }));
    expect(within(inspector).getByText(/implemented the migration/i)).toBeInTheDocument();
    expect(within(conversation).getByRole("textbox", { name: /reply or steer/i }))
      .toBeInTheDocument();
  });

  it("reveals a dashboard that hydrates after the session inspector opens", () => {
    const { rerender } = render(
      <ActivityView
        sessions={[session({
          sessionKey: "hydrating-leader",
          status: "running",
          role: "leader",
          taskName: "Hydrating dashboard",
        })]}
        nodes={[]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /hydrating dashboard/i }));
    const inspector = screen.getByRole("complementary", { name: /session details/i });
    const dashboardTab = within(inspector).getByRole("tab", { name: /dashboard/i });
    expect(dashboardTab).toHaveAttribute("aria-selected", "false");

    rerender(
      <ActivityView
        sessions={[session({
          sessionKey: "hydrating-leader",
          status: "running",
          role: "leader",
          taskName: "Hydrating dashboard",
          renderState: {
            layout: { title: "Live progress", columns: 1 },
            components: [{ id: "status", type: "text", content: "Dashboard hydrated" }],
          },
        })]}
        nodes={[]}
        {...noop}
      />,
    );

    expect(dashboardTab).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByText("Dashboard hydrated")).toBeInTheDocument();
  });

  it("enables node actions and fires them with the node id when a canvas node exists", () => {
    const onOpenInCanvas = vi.fn();
    const onExpandFullscreen = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Has node" })]}
        nodes={[leaderNode("run")]}
        onLaunchLeader={() => {}}
        onCommitLaunchLeader={() => {}}
        onCancelLaunchLeader={() => {}}
        onOpenInCanvas={onOpenInCanvas}
        onExpandFullscreen={onExpandFullscreen}
        onStopSession={() => {}}
        onAttachToCanvas={() => {}}
        onUpdateNodeData={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /has node/i }));
    const expandBtn = screen.getByRole("button", { name: /expand fullscreen/i });
    const openBtn = screen.getByRole("button", { name: /open in canvas/i });
    expect(expandBtn).toBeEnabled();
    expect(openBtn).toBeEnabled();

    fireEvent.click(expandBtn);
    fireEvent.click(openBtn);
    expect(onExpandFullscreen).toHaveBeenCalledWith("node-run");
    expect(onOpenInCanvas).toHaveBeenCalledWith("node-run");
  });

  it("offers optional canvas placement when the session has no canvas node", () => {
    const onAttachToCanvas = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "mobile-run", status: "running", taskName: "From phone" })]}
        nodes={[]}
        {...noop}
        onAttachToCanvas={onAttachToCanvas}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /from phone/i }));
    // The canvas-node actions are absent; placement remains an optional action.
    expect(screen.queryByRole("button", { name: /expand fullscreen/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open in canvas/i })).not.toBeInTheDocument();

    const attachBtn = screen.getByRole("button", { name: /add to canvas/i });
    expect(attachBtn).toBeEnabled();
    fireEvent.click(attachBtn);
    expect(onAttachToCanvas).toHaveBeenCalledWith("mobile-run");
  });

  it("loads and follows a node-less session transcript by session key", async () => {
    const socketSend = vi.fn();
    const listeners = new Set<(message: unknown) => void>();
    const socketSubscribe = ((
      topicOrListener: string | ((message: unknown) => void),
      maybeListener?: (message: unknown) => void,
    ) => {
      const listener = typeof topicOrListener === "function"
        ? topicOrListener
        : maybeListener!;
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as SocketSubscribe;
    Object.defineProperty(socketSubscribe, "supportsTopics", { value: true });

    render(
      <ActivityView
        sessions={[session({
          sessionKey: "server-only",
          status: "running",
          taskName: "Server-owned session",
        })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /server-owned session/i }));
    await waitFor(() => {
      expect(socketSend).toHaveBeenCalledWith({
        type: "sync_session",
        sessionKey: "server-only",
      });
    });

    act(() => {
      for (const listener of listeners) {
        listener({
          type: "sync_response",
          sessionKey: "server-only",
          found: true,
          status: "running",
          events: [{
            type: "sdk_event",
            sessionKey: "server-only",
            timestamp: 1,
            event: { kind: "text", role: "assistant", text: "Loaded from the server." },
          }],
        });
      }
    });
    expect(screen.getByText("Loaded from the server.")).toBeInTheDocument();

    act(() => {
      for (const listener of listeners) {
        listener({
          type: "sdk_event",
          sessionKey: "server-only",
          event: { kind: "text", role: "assistant", text: "Still updating live." },
        });
      }
    });
    expect(screen.getByText("Still updating live.")).toBeInTheDocument();
    expect(screen.queryByText(/attach this session/i)).not.toBeInTheDocument();
  });

  it("renders one ordered transcript across every run in a work item", async () => {
    const socketSend = vi.fn();
    const listeners = new Set<(message: unknown) => void>();
    const socketSubscribe = ((
      topicOrListener: string | ((message: unknown) => void),
      maybeListener?: (message: unknown) => void,
    ) => {
      const listener = typeof topicOrListener === "function" ? topicOrListener : maybeListener!;
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as SocketSubscribe;
    Object.defineProperty(socketSubscribe, "supportsTopics", { value: true });
    const runs = [
      { runKey: "run-2", workItemId: "work-1", runKind: "primary" as const,
        parentRunKey: null, taskId: null, runNumber: 2, previousRunKey: "run-1",
        providerSessionId: null, outcome: "none" as const, startedAt: 20,
        endedAt: null, finalReport: null },
      { runKey: "run-1", workItemId: "work-1", runKind: "primary" as const,
        parentRunKey: null, taskId: null, runNumber: 1, previousRunKey: null,
        providerSessionId: null, outcome: "completed" as const, startedAt: 10,
        endedAt: 11, finalReport: "First complete" },
    ];

    render(
      <ActivityView
        sessions={[session({ sessionKey: "run-2", workItemId: "work-1",
          canonicalWorkItem: true, role: "leader", status: "running", taskName: "Unified work" })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
        workItemRuns={{ "work-1": runs }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /unified work/i }));
    await waitFor(() => expect(socketSend).toHaveBeenCalledWith({
      type: "sync_session", sessionKey: "run-1",
    }));

    act(() => {
      for (const listener of listeners) {
        listener({
          type: "sync_response", sessionKey: "run-1", found: true, status: "completed",
          events: [{ type: "sdk_event", sessionKey: "run-1", timestamp: 11,
            event: { kind: "text", role: "assistant", text: "Earlier iteration output" } }],
        });
        listener({
          type: "sync_response", sessionKey: "run-2", found: true, status: "running",
          events: [{ type: "sdk_event", sessionKey: "run-2", timestamp: 21,
            event: { kind: "text", role: "assistant", text: "Current iteration output" } }],
        });
      }
    });

    expect(screen.getByText("Iteration 1 · completed")).toBeInTheDocument();
    expect(screen.getByText("Earlier iteration output")).toBeInTheDocument();
    expect(screen.getByText("Iteration 2 · Active now")).toBeInTheDocument();
    expect(screen.getByText("Current iteration output")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Session details" }));
    fireEvent.click(screen.getByText("Run history"));
    const history = screen.getByRole("list", { name: "Run history" });
    expect(within(history).getByText("Iteration 1")).toBeInTheDocument();
    expect(within(history).queryByText("Iteration 2")).not.toBeInTheDocument();

    fireEvent.click(within(history).getByRole("button", { name: /iteration 1/i }));
    const preview = screen.getByRole("region", { name: "Preview of iteration 1" });
    expect(within(preview).getByText("Earlier iteration output")).toBeInTheDocument();
    expect(within(preview).getByText("First complete")).toBeInTheDocument();
    expect(within(preview).getByText("Read-only preview")).toBeInTheDocument();
  });

  it("loads iteration history once when a work-item session opens", async () => {
    const onLoadRuns = vi.fn();
    render(
      <ActivityView
        sessions={[session({
          sessionKey: "run-2",
          workItemId: "work-1",
          canonicalWorkItem: true,
          role: "leader",
          status: "running",
          taskName: "History loading",
        })]}
        nodes={[]}
        {...noop}
        onLoadRuns={onLoadRuns}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /history loading/i }));
    await waitFor(() => expect(onLoadRuns).toHaveBeenCalledTimes(1));
    expect(onLoadRuns).toHaveBeenLastCalledWith("work-1", undefined);

    fireEvent.click(screen.getByRole("tab", { name: "Session details" }));
    expect(onLoadRuns).toHaveBeenCalledTimes(1);
  });

  it("hides Add to canvas once the session has a canvas node", () => {
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Has node" })]}
        nodes={[leaderNode("run")]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /has node/i }));
    expect(screen.queryByRole("button", { name: /add to canvas/i })).not.toBeInTheDocument();
  });

  it("only enables Stop for a running session and reports its session key", () => {
    const onStopSession = vi.fn();
    const { rerender } = render(
      <ActivityView
        sessions={[session({ sessionKey: "idle1", status: "idle", taskName: "Idle one" })]}
        nodes={[]}
        onLaunchLeader={() => {}}
        onCommitLaunchLeader={() => {}}
        onCancelLaunchLeader={() => {}}
        onOpenInCanvas={() => {}}
        onExpandFullscreen={() => {}}
        onStopSession={onStopSession}
        onAttachToCanvas={() => {}}
        onUpdateNodeData={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /idle one/i }));
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeDisabled();

    rerender(
      <ActivityView
        sessions={[session({ sessionKey: "run1", status: "running", taskName: "Running one" })]}
        nodes={[]}
        onLaunchLeader={() => {}}
        onCommitLaunchLeader={() => {}}
        onCancelLaunchLeader={() => {}}
        onOpenInCanvas={() => {}}
        onExpandFullscreen={() => {}}
        onStopSession={onStopSession}
        onAttachToCanvas={() => {}}
        onUpdateNodeData={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /running one/i }));
    const stop = screen.getByRole("button", { name: /^stop$/i });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(onStopSession).toHaveBeenCalledWith("run1");
  });

  it("renders the live transcript for a session backed by a canvas node", () => {
    const messages: DisplayMessage[] = [
      { id: "u1", role: "user", content: "Do the thing", timestamp: 1 },
      { id: "a1", role: "assistant", content: "On it.", timestamp: 2 },
    ];
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Chatty" })]}
        nodes={[leaderNode("run", messages)]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /chatty/i }));
    expect(screen.getByText("Do the thing")).toBeInTheDocument();
    expect(screen.getByText("On it.")).toBeInTheDocument();
  });
});
