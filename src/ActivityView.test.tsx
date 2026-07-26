import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { act } from "react";

import { ActivityView, lifecycleActionError } from "./ActivityView.tsx";
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
  onCancelLaunchLeader: () => {},
  onOpenInCanvas: () => {},
  onExpandFullscreen: () => {},
  onStopSession: () => {},
  onAttachToCanvas: () => {},
  onUpdateNodeData: () => {},
};

describe("ActivityView", () => {
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
    const row = screen.getByText("hi").closest(".act-triage-row") as HTMLElement;
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
    const row = screen.getByText("Finished task").closest(".act-triage-row") as HTMLElement;
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

      const row = screen.getByText("Canonical done").closest(".act-triage-row") as HTMLElement;
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

  it("steers a selected session from the inline Activity composer", () => {
    const socketSend = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Working" })]}
        nodes={[]}
        {...noop}
        socketSend={socketSend}
      />,
    );
    fireEvent.click(screen.getByText("Working").closest("button")!);
    fireEvent.change(screen.getByRole("textbox", { name: /reply or steer/i }), {
      target: { value: "Use the safer migration." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(socketSend).toHaveBeenCalledWith({
      type: "send_message",
      sessionKey: "run",
      prompt: "Use the safer migration.",
    });
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

  it("offers a Launch action from the activity header", () => {
    const onLaunchLeader = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Working" })]}
        nodes={[]}
        {...noop}
        onLaunchLeader={onLaunchLeader}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /launch leader/i }));
    expect(onLaunchLeader).toHaveBeenCalledTimes(1);
  });

  it("auto-opens a responsive, modal-free launch composer in the empty state", () => {
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
    expect(screen.getByRole("complementary", { name: /run setup/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /model/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /permissions/i })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /launch workspace open/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /isolated worktree/i }));
    expect(onUpdateNodeData).toHaveBeenLastCalledWith(
      draft.id,
      expect.objectContaining({ worktreeIsolation: true }),
    );
    expect(screen.queryByRole("button", { name: /open on canvas/i })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: /launch leader/i }));
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

  it("offers Launch from the empty activity state when no draft could be created", () => {
    // onLaunchLeader returns void — the auto-open attempt yields no draft, so
    // the empty state falls back to an explicit Launch CTA.
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
    fireEvent.click(screen.getByRole("button", { name: /^launch$/i }));
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

  it("previews recent work in the filtered-empty state and attaches node-less sessions", () => {
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
    expect(onAttachToCanvas).toHaveBeenCalledWith("idle-1");
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
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.queryByText("Needs reply")).not.toBeInTheDocument();
    expect(screen.queryByText("Taking a break")).not.toBeInTheDocument();

    fireEvent.click(workingFilter);
    expect(workingFilter).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Needs reply")).toBeInTheDocument();
    expect(screen.getByText("Taking a break")).toBeInTheDocument();
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
    expect(screen.getByText("Needs reply")).toBeInTheDocument();
    expect(screen.queryByText("Taking a break")).not.toBeInTheDocument();

    const waitingFilter = screen.getByRole("button", { name: /waiting: 1\. filter activity/i });
    fireEvent.click(waitingFilter);
    expect(waitingFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Needs reply")).toBeInTheDocument();

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

  it("enables node actions and fires them with the node id when a canvas node exists", () => {
    const onOpenInCanvas = vi.fn();
    const onExpandFullscreen = vi.fn();
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Has node" })]}
        nodes={[leaderNode("run")]}
        onLaunchLeader={() => {}}
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

  it("offers Attach to canvas (not disabled node actions) when the session has no canvas node", () => {
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
    // The canvas-node actions are absent; an enabled Attach action stands in.
    expect(screen.queryByRole("button", { name: /expand fullscreen/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open in canvas/i })).not.toBeInTheDocument();

    const attachBtn = screen.getByRole("button", { name: /attach to canvas/i });
    expect(attachBtn).toBeEnabled();
    fireEvent.click(attachBtn);
    expect(onAttachToCanvas).toHaveBeenCalledWith("mobile-run");
  });

  it("hides Attach to canvas once the session has a canvas node", () => {
    render(
      <ActivityView
        sessions={[session({ sessionKey: "run", status: "running", taskName: "Has node" })]}
        nodes={[leaderNode("run")]}
        {...noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /has node/i }));
    expect(screen.queryByRole("button", { name: /attach to canvas/i })).not.toBeInTheDocument();
  });

  it("only enables Stop for a running session and reports its session key", () => {
    const onStopSession = vi.fn();
    const { rerender } = render(
      <ActivityView
        sessions={[session({ sessionKey: "idle1", status: "idle", taskName: "Idle one" })]}
        nodes={[]}
        onLaunchLeader={() => {}}
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
