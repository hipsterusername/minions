/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ServerMessage, SessionInfo, SocketSubscribe } from "./use-socket.ts";
import {
  activityFromMessage,
  reduceSessionActivity,
  useSessionActivity,
} from "./use-session-activity.ts";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionKey: "s1",
    sessionId: null,
    status: "idle",
    cwd: "/proj",
    ...overrides,
  };
}

function emptyState() {
  return { sessions: [] as SessionInfo[], activities: {}, attention: {} };
}

describe("activityFromMessage", () => {
  it("maps minion_status with fail trigger to an attention activity", () => {
    const activity = activityFromMessage({
      type: "minion_status",
      minionSessionKey: "m1",
      trigger: "fail",
      message: "boom",
      timestamp: 100,
    } as ServerMessage);
    expect(activity).toEqual({
      sessionKey: "m1",
      text: "boom",
      timestamp: 100,
      attention: true,
    });
  });

  it("treats a non-fail minion_status as non-attention", () => {
    const activity = activityFromMessage({
      type: "minion_status",
      minionSessionKey: "m1",
      trigger: "step",
      message: "working",
      timestamp: 5,
    } as ServerMessage);
    expect(activity?.attention).toBe(false);
  });

  it("flags wait_state and approval_requested as needing attention", () => {
    expect(
      activityFromMessage({
        type: "wait_state",
        sessionKey: "s1",
        action: "wait",
        reason: "waiting",
        timestamp: 1,
      } as ServerMessage)?.attention,
    ).toBe(true);
    expect(
      activityFromMessage({
        type: "approval_requested",
        sessionKey: "s1",
        summary: "review please",
        diff: null,
        timestamp: 1,
      } as ServerMessage)?.attention,
    ).toBe(true);
  });

  it("clears attention when an approval resolves", () => {
    const activity = activityFromMessage({
      type: "approval_resolved",
      sessionKey: "s1",
      action: "approved",
      timestamp: 1,
    } as ServerMessage);
    expect(activity).toMatchObject({ attention: false, text: "Approval approved" });
  });

  it("strips the task-name marker from assistant sdk_event text", () => {
    const activity = activityFromMessage({
      type: "sdk_event",
      sessionKey: "s1",
      event: { kind: "text", role: "assistant", text: "<!--task-name:Foo--> hello there" },
      timestamp: 123,
    } as ServerMessage);
    expect(activity?.text).toBe("hello there");
    expect(activity?.timestamp).toBe(123);
    // No attention key — plain chatter must not change the flag.
    expect(activity?.attention).toBeUndefined();
  });

  it("ignores non-assistant sdk events and unrelated messages", () => {
    expect(
      activityFromMessage({
        type: "sdk_event",
        sessionKey: "s1",
        event: { kind: "text", role: "user", text: "hi" },
      } as ServerMessage),
    ).toBeNull();
    expect(
      activityFromMessage({ type: "session_list", sessions: [] } as ServerMessage),
    ).toBeNull();
  });
});

describe("useSessionActivity", () => {
  it("uses snapshot lastActivityAt until a newer live activity arrives", () => {
    let listener: ((msg: ServerMessage) => void) | null = null;
    const subscribe: SocketSubscribe = ((_topicOrFn: unknown, maybeFn?: unknown) => {
      listener = (typeof maybeFn === "function" ? maybeFn : _topicOrFn) as (msg: ServerMessage) => void;
      return () => {
        listener = null;
      };
    }) as SocketSubscribe;

    const { result } = renderHook(() => useSessionActivity(subscribe));

    act(() => {
      listener?.({
        type: "session_list",
        sessions: [
          session({ sessionKey: "old", status: "stopped", lastActivityAt: 100 }),
          session({ sessionKey: "new", status: "completed", lastActivityAt: 200 }),
        ],
      } as ServerMessage);
    });

    expect(result.current.mobileSessions.map((s) => [s.sessionKey, s.lastActivityAt])).toEqual([
      ["old", 100],
      ["new", 200],
    ]);

    act(() => {
      listener?.({
        type: "sdk_event",
        sessionKey: "old",
        event: { kind: "text", role: "assistant", text: "fresh reply" },
        timestamp: 300,
      } as ServerMessage);
    });

    expect(result.current.mobileSessions.find((s) => s.sessionKey === "old")?.lastActivityAt).toBe(300);
  });

  it("adds a missing session from a found sync_response snapshot", () => {
    let listener: ((msg: ServerMessage) => void) | null = null;
    const subscribe: SocketSubscribe = ((_topicOrFn: unknown, maybeFn?: unknown) => {
      listener = (typeof maybeFn === "function" ? maybeFn : _topicOrFn) as (msg: ServerMessage) => void;
      return () => {
        listener = null;
      };
    }) as SocketSubscribe;

    const { result } = renderHook(() => useSessionActivity(subscribe));

    act(() => {
      listener?.({
        type: "sync_response",
        sessionKey: "leader-new",
        found: true,
        status: "running",
        sessionId: "sdk-1",
        cwd: "/proj",
        role: "leader",
        taskName: "New leader",
        totalCost: 0.25,
        turns: 2,
        model: "sonnet",
        harness: "claude",
      } as ServerMessage);
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.mobileSessions[0]).toMatchObject({
      sessionKey: "leader-new",
      sessionId: "sdk-1",
      cwd: "/proj",
      role: "leader",
      status: "running",
      taskName: "New leader",
      totalCost: 0.25,
      turns: 2,
      model: "sonnet",
      harness: "claude",
    });
  });
});

describe("reduceSessionActivity", () => {
  it("replaces the session list on session_list", () => {
    const next = reduceSessionActivity(emptyState(), {
      type: "session_list",
      sessions: [session({ sessionKey: "a" }), session({ sessionKey: "b" })],
    } as ServerMessage);
    expect(next.sessions.map((s) => s.sessionKey)).toEqual(["a", "b"]);
  });

  it("patches a single session's status on session_status", () => {
    const start = {
      ...emptyState(),
      sessions: [session({ sessionKey: "a", status: "idle" })],
    };
    const next = reduceSessionActivity(start, {
      type: "session_status",
      sessionKey: "a",
      status: "running",
    } as ServerMessage);
    expect(next.sessions[0]!.status).toBe("running");
  });

  it("stores dashboard render state from sync_response", () => {
    const start = {
      ...emptyState(),
      sessions: [session({ sessionKey: "leader-1", status: "running" })],
    };
    const next = reduceSessionActivity(start, {
      type: "sync_response",
      sessionKey: "leader-1",
      found: true,
      renderState: {
        layout: { title: "Build status", columns: 1 },
        components: [{ id: "status", type: "text", content: "Dashboard online" }],
      },
    } as ServerMessage);

    expect(next.sessions[0]!.renderState?.layout.title).toBe("Build status");
    expect(next.sessions[0]!.renderState?.components).toHaveLength(1);
  });

  it("upserts a missing session from sync_response so Activity can recover after a missed list", () => {
    const next = reduceSessionActivity(emptyState(), {
      type: "sync_response",
      sessionKey: "leader-new",
      found: true,
      status: "running",
      sessionId: "sdk-1",
      cwd: "/proj",
      role: "leader",
      taskName: "New leader",
      totalCost: 0.25,
      turns: 2,
      model: "sonnet",
      harness: "claude",
    } as ServerMessage);

    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]).toMatchObject({
      sessionKey: "leader-new",
      sessionId: "sdk-1",
      cwd: "/proj",
      role: "leader",
      status: "running",
      taskName: "New leader",
      totalCost: 0.25,
      turns: 2,
      model: "sonnet",
      harness: "claude",
    });
  });

  it("applies render_update messages to the stored dashboard state", () => {
    const start = {
      ...emptyState(),
      sessions: [
        session({
          sessionKey: "leader-1",
          renderState: {
            layout: { title: "Build status", columns: 1 },
            components: [{ id: "status", type: "text", content: "Dashboard online" }],
          },
        }),
      ],
    };
    const next = reduceSessionActivity(start, {
      type: "render_update",
      leaderSessionKey: "leader-1",
      action: "patch",
      updates: [{ id: "status", content: "Dashboard refreshed" }],
    } as ServerMessage);

    expect(next.sessions[0]!.renderState?.components[0]).toMatchObject({
      id: "status",
      type: "text",
      content: "Dashboard refreshed",
    });
  });

  it("records activity text and attention, and leaves attention untouched when undefined", () => {
    let state = reduceSessionActivity(emptyState(), {
      type: "wait_state",
      sessionKey: "a",
      action: "wait",
      reason: "needs you",
      timestamp: 10,
    } as ServerMessage);
    expect(state.activities["a"]).toEqual({ text: "needs you", timestamp: 10 });
    expect(state.attention["a"]).toBe(true);

    // Plain assistant chatter updates text but must not clear the attention flag.
    state = reduceSessionActivity(state, {
      type: "sdk_event",
      sessionKey: "a",
      event: { kind: "text", role: "assistant", text: "still thinking" },
    } as ServerMessage);
    expect(state.activities["a"]!.text).toBe("still thinking");
    expect(state.attention["a"]).toBe(true);
  });
});
