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

function leaderNode(sessionKey: string, messages: DisplayMessage[] = []): CanvasNode {
  const data: Partial<LeaderData> = {
    sessionKey,
    status: "running",
    messages,
    streamingText: "",
    totalCost: 0,
    turns: 0,
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
};

describe("ActivityView", () => {
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
