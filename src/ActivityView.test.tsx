import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityView } from "./ActivityView.tsx";
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
    fireEvent.click(screen.getByRole("button", { name: /mark reviewed/i }));
    expect(socketSend).toHaveBeenCalledWith({
      type: "acknowledge_session",
      sessionKey: "done",
      expectedLifecycleRevision: 3,
    });
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(socketSend).toHaveBeenCalledWith({
      type: "dismiss_session",
      sessionKey: "done",
      expectedLifecycleRevision: 3,
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
    fireEvent.click(screen.getByRole("button", { name: /working/i }));
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

  it("opens compact leader inputs in the Activity panel", () => {
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

    fireEvent.click(screen.getByRole("button", { name: /launch leader/i }));
    expect(screen.getByRole("region", { name: /new leader/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Describe your project goal...")).toBeInTheDocument();
    const advancedSetup = screen.getByText("Advanced setup").closest("details");
    expect(advancedSetup).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("Advanced setup"));
    expect(advancedSetup).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: /^skills$/i }));
    expect(screen.getByRole("dialog", { name: /choose skills/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open on canvas/i })).not.toBeInTheDocument();
  });

  it("selects the newly created leader in Activity when its session appears", () => {
    const draft = leaderNode("", [], { sessionKey: null, status: "disconnected" });
    const props = {
      ...noop,
      onLaunchLeader: () => draft.id,
      projectPath: "/tmp/project",
    };
    const { rerender } = render(<ActivityView sessions={[]} nodes={[draft]} {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /launch leader/i }));
    expect(screen.getByRole("region", { name: /new leader/i })).toBeInTheDocument();

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

    expect(screen.queryByRole("region", { name: /new leader/i })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /session details/i })).toHaveTextContent("Fresh task");
  });

  it("offers Launch from the empty activity state", () => {
    const onLaunchLeader = vi.fn();
    render(
      <ActivityView
        sessions={[]}
        nodes={[]}
        {...noop}
        onLaunchLeader={onLaunchLeader}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^launch$/i }));
    expect(onLaunchLeader).toHaveBeenCalledTimes(1);
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
