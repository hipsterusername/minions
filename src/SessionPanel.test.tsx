import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useEffect } from "react";
import { SessionPanel } from "./SessionPanel.tsx";
import { DockProvider, useDock } from "./BottomRightDock.tsx";
import type { SessionInfo } from "./use-socket.ts";

function OpenSessionsOnMount() {
  const { openPanel } = useDock();
  useEffect(() => {
    openPanel("sessions");
  }, [openPanel]);
  return null;
}

function renderPanel(props: Parameters<typeof SessionPanel>[0]) {
  return render(
    <DockProvider>
      <SessionPanel {...props} />
    </DockProvider>,
  );
}

let listeners: Array<(msg: unknown) => void> = [];

function subscribe(fn: (msg: unknown) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

beforeEach(() => {
  listeners = [];
});

describe("SessionPanel usage section", () => {
  it("usage section is not visible when panel is collapsed", () => {
    renderPanel({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      attachedSessionKeys: new Set(),
    });
    expect(screen.queryByTestId("usage-section")).toBeNull();
  });
});

function renderOpen(props: Parameters<typeof SessionPanel>[0]) {
  return render(
    <DockProvider>
      <OpenSessionsOnMount />
      <SessionPanel {...props} />
    </DockProvider>,
  );
}

function emitSessions(list: SessionInfo[]) {
  act(() => {
    for (const fn of listeners) {
      fn({ type: "session_list", sessions: list });
    }
  });
}

function session(overrides: Partial<SessionInfo> & { sessionKey: string }): SessionInfo {
  return {
    sessionId: null,
    status: "idle",
    cwd: "",
    role: "default",
    ...overrides,
  };
}

describe("SessionPanel attached / unattached grouping", () => {
  it("renders a Focus button for attached sessions and hides unattached behind a toggle", () => {
    const onFocus = vi.fn();
    renderOpen({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      onFocusSession: onFocus,
      attachedSessionKeys: new Set(["attached-1"]),
    });

    emitSessions([
      session({ sessionKey: "attached-1", taskName: "On Canvas Task" }),
      session({ sessionKey: "loose-1", taskName: "Loose Task" }),
    ]);

    // Attached session is rendered as a row with a Focus button.
    const attachedRows = screen.getAllByTestId("session-row-attached");
    expect(attachedRows).toHaveLength(1);
    expect(attachedRows[0]).toHaveTextContent("On Canvas Task");
    const focusBtn = screen.getByRole("button", { name: /focus/i });

    // Unattached row is hidden by default — only the collapsed toggle is shown.
    expect(screen.queryByTestId("session-row-unattached")).toBeNull();
    const toggle = screen.getByTestId("unattached-toggle");
    expect(toggle).toHaveTextContent(/not on canvas\s*1/i);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Clicking Focus invokes onFocusSession with the attached session key.
    fireEvent.click(focusBtn);
    expect(onFocus).toHaveBeenCalledWith("attached-1");

    // Expanding the toggle reveals the unattached row.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const unattachedRows = screen.getAllByTestId("session-row-unattached");
    expect(unattachedRows).toHaveLength(1);
    expect(unattachedRows[0]).toHaveTextContent("Loose Task");
  });

  it("omits the unattached toggle when every session is on the canvas", () => {
    renderOpen({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      onFocusSession: () => {},
      attachedSessionKeys: new Set(["only-1"]),
    });

    emitSessions([session({ sessionKey: "only-1", taskName: "Solo" })]);

    expect(screen.getAllByTestId("session-row-attached")).toHaveLength(1);
    expect(screen.queryByTestId("unattached-toggle")).toBeNull();
  });

  it("renders token totals and cache hit rate from the session snapshot", () => {
    renderOpen({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      onFocusSession: () => {},
      attachedSessionKeys: new Set(["usage-1"]),
    });

    emitSessions([
      session({
        sessionKey: "usage-1",
        taskName: "Measured",
        usageTotals: {
          input: 412_000,
          output: 38_000,
          cacheRead: 4_120_000,
          cacheCreation: 10_000,
          cacheHitRate: 0.909090909,
        },
      }),
    ]);

    expect(screen.getByTestId("session-row-attached")).toHaveTextContent(
      "in 412k / out 38k / cache 91%",
    );
  });

  it("updates visible cost totals from live usage events", () => {
    renderOpen({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      onFocusSession: () => {},
      attachedSessionKeys: new Set(["usage-1"]),
    });

    emitSessions([
      session({
        sessionKey: "usage-1",
        taskName: "Measured",
        totalCost: 0,
      }),
    ]);

    expect(screen.getByTestId("session-row-attached")).not.toHaveTextContent("$0.1234");

    act(() => {
      for (const fn of listeners) {
        fn({
          type: "sdk_event",
          sessionKey: "usage-1",
          event: {
            kind: "usage",
            source: "result",
            input: 100,
            output: 10,
            costUSD: 0.1234,
          },
        });
      }
    });

    expect(screen.getByTestId("session-row-attached")).toHaveTextContent("$0.1234");
  });

  it("keeps the usage summary scoped to sessions represented by the panel", () => {
    renderOpen({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      attachedSessionKeys: new Set(["leader-1"]),
    });

    emitSessions([
      session({
        sessionKey: "leader-1",
        role: "leader",
        totalCost: 1,
        turns: 2,
      }),
      session({
        sessionKey: "minion-1",
        role: "minion",
        totalCost: 9,
        turns: 20,
      }),
    ]);

    const summary = within(screen.getByTestId("usage-section"));
    expect(summary.getByTitle("$1.0000")).toBeInTheDocument();
    expect(summary.queryByTitle("$10.0000")).toBeNull();
    expect(summary.getByTitle("2")).toBeInTheDocument();
  });

  it("hides unattached sessions that belong to a different project", () => {
    const socketSend = vi.fn();
    renderOpen({
      socketSend,
      socketSubscribe: subscribe,
      projectPath: "/repos/current",
      onAttachSession: () => {},
      attachedSessionKeys: new Set(["attached-from-worktree"]),
    });

    emitSessions([
      session({
        sessionKey: "current-unattached",
        cwd: "/repos/current/packages/app",
        taskName: "Current project",
      }),
      session({
        sessionKey: "other-unattached",
        cwd: "/repos/other",
        taskName: "Other project",
      }),
      session({
        sessionKey: "attached-from-worktree",
        cwd: "/tmp/external-worktree",
        taskName: "Attached elsewhere",
      }),
    ]);

    expect(screen.getByTestId("session-row-attached")).toHaveTextContent(
      "Attached elsewhere",
    );
    expect(screen.getByTestId("unattached-toggle")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("unattached-toggle"));
    expect(screen.getByTestId("session-row-unattached")).toHaveTextContent(
      "Current project",
    );
    expect(screen.queryByText("Other project")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear inactive sessions" }),
    );
    expect(socketSend).toHaveBeenCalledTimes(2);
    expect(socketSend).toHaveBeenCalledWith({
      type: "remove_session",
      sessionKey: "current-unattached",
    });
    expect(socketSend).toHaveBeenCalledWith({
      type: "remove_session",
      sessionKey: "attached-from-worktree",
    });
  });

  it("clears all visible inactive sessions without touching active or hidden sessions", () => {
    const socketSend = vi.fn();
    renderOpen({
      socketSend,
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      onFocusSession: () => {},
      attachedSessionKeys: new Set([
        "idle-1",
        "stopped-1",
        "running-1",
        "error-1",
        "minion-1",
      ]),
    });

    emitSessions([
      session({ sessionKey: "idle-1", status: "idle", taskName: "Idle" }),
      session({ sessionKey: "stopped-1", status: "stopped", taskName: "Stopped" }),
      session({ sessionKey: "running-1", status: "running", taskName: "Running" }),
      session({ sessionKey: "error-1", status: "error", taskName: "Error" }),
      session({ sessionKey: "minion-1", status: "idle", role: "minion" }),
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Clear inactive sessions" }),
    );

    expect(socketSend).toHaveBeenCalledTimes(3);
    expect(socketSend).toHaveBeenNthCalledWith(1, {
      type: "remove_session",
      sessionKey: "idle-1",
    });
    expect(socketSend).toHaveBeenNthCalledWith(2, {
      type: "remove_session",
      sessionKey: "stopped-1",
    });
    expect(socketSend).toHaveBeenNthCalledWith(3, {
      type: "remove_session",
      sessionKey: "error-1",
    });
  });

  it("disables Clear inactive when only running sessions exist", () => {
    renderOpen({
      socketSend: vi.fn(),
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      onFocusSession: () => {},
      attachedSessionKeys: new Set(["running-1"]),
    });

    emitSessions([
      session({ sessionKey: "running-1", status: "running", taskName: "Running" }),
    ]);

    expect(
      screen.getByRole("button", { name: "Clear inactive sessions" }),
    ).toBeDisabled();
  });

  it("disables destructive controls when there is no socket connection", () => {
    renderOpen({
      socketSubscribe: subscribe,
      onAttachSession: () => {},
      onFocusSession: () => {},
      attachedSessionKeys: new Set(["running-1", "idle-1"]),
    });

    emitSessions([
      session({ sessionKey: "running-1", status: "running", taskName: "Running" }),
      session({ sessionKey: "idle-1", status: "idle", taskName: "Idle" }),
    ]);

    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Idle" })).toBeDisabled();
  });
});
