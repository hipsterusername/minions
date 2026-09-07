/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ServerMessage, SessionInfo, SocketSubscribe } from "./use-socket.ts";
import { activityEntryId, mergeCanonicalActivity } from "./use-work-items.ts";
import { initialWorkItemLifecycle } from "../shared/work-item-lifecycle.ts";
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

describe("launch identity reconciliation", () => {
  it("updates live titles and terminal status on every activity surface", () => {
    let state = { ...emptyState(), sessions: [session()] };
    state = reduceSessionActivity(state, {
      type: "session_task_name", sessionKey: "s1", taskName: "Canonical task name",
    });
    expect(state.sessions[0]?.taskName).toBe("Canonical task name");
    state = reduceSessionActivity(state, { type: "session_error", sessionKey: "s1", error: "Failed" });
    expect(state.sessions[0]?.status).toBe("error");
    state = reduceSessionActivity(state, {
      type: "session_completed", sessionKey: "s1", reason: "Done", timestamp: 3,
    });
    expect(state.sessions[0]?.status).toBe("completed");
  });

  it("recovers activity from a snapshot without replacing newer live activity", () => {
    const snapshot: ServerMessage = { type: "sync_response", sessionKey: "s1", found: true,
      events: [{ type: "sdk_event", sessionKey: "s1", timestamp: 1,
        event: { kind: "text", role: "assistant", text: "Early reply" } }] };
    let state = reduceSessionActivity(emptyState(), snapshot);
    expect(state.activities["s1"]?.text).toBe("Early reply");
    state = reduceSessionActivity(state, { type: "sdk_event", sessionKey: "s1", timestamp: 2,
      event: { kind: "text", role: "assistant", text: "New reply" } });
    state = reduceSessionActivity(state, snapshot);
    expect(state.activities["s1"]?.text).toBe("New reply");
  });

  it.each([false, true])("preserves sync lineage with an existing session: %s", (existing) => {
    const identity = { workItemId: "work-1", runKey: "s1", runKind: "primary" as const,
      parentRunKey: null, taskId: null };
    const next = reduceSessionActivity({ ...emptyState(), sessions: existing ? [session()] : [] }, {
      type: "sync_response", sessionKey: "s1", found: true, ...identity,
      status: "running", cwd: "/proj", role: "leader",
    });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]).toMatchObject(identity);
    const partial = reduceSessionActivity(next, {
      type: "sync_response", sessionKey: "s1", found: true, status: "idle",
    });
    expect(partial.sessions[0]).toMatchObject(identity);
  });

  it.each(["sync-first", "work-item-first"])("keeps one Activity entry during launch (%s)", (order) => {
    const draft = { id: "work-1", projectId: "p1", projectPath: "/proj", title: "Launch task",
      lifecycle: initialWorkItemLifecycle(), currentRunKey: null, waitKind: null,
      iteration: 0, lastTransitionAt: 1, createdAt: 1, updatedAt: 1 };
    const started = { ...draft, currentRunKey: "s1", iteration: 1, updatedAt: 2,
      lifecycle: { ...draft.lifecycle, runtimeState: "working" as const, lifecycleRevision: 1 } };
    const synced = reduceSessionActivity(emptyState(), {
      type: "sync_response", sessionKey: "s1", found: true, workItemId: draft.id,
      runKey: "s1", runKind: "primary", role: "leader", status: "running", cwd: "/proj",
    });
    const stages = [
      mergeCanonicalActivity([], [draft]),
      order === "sync-first" ? mergeCanonicalActivity(synced.sessions, [draft])
        : mergeCanonicalActivity([], [started]),
      mergeCanonicalActivity(synced.sessions, [started]),
    ];
    for (const rows of stages) {
      expect(rows).toHaveLength(1);
      expect(activityEntryId(rows[0]!)).toBe("work-item:work-1");
    }
    expect(stages[2]![0]).toMatchObject({ sessionKey: "s1", status: "running" });
  });
});

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
        action: "started",
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
  it("keeps live status, dashboard and attention updates together", () => {
    let emit: (message: ServerMessage) => void = () => {};
    const subscribe = ((_topic: string, listener: (message: ServerMessage) => void) => {
      emit = listener;
      return () => { emit = () => {}; };
    }) as SocketSubscribe;
    const { result } = renderHook(() => useSessionActivity(subscribe));
    act(() => {
      emit({ type: "session_list", sessions: [session()] } as ServerMessage);
      emit({ type: "session_status", sessionKey: "s1", status: "running" } as ServerMessage);
      emit({ type: "render_update", leaderSessionKey: "s1", action: "set",
        layout: { columns: 1 }, components: [{ id: "status", type: "text", content: "Ready" }] } as ServerMessage);
      emit({ type: "wait_state", sessionKey: "s1", action: "started", reason: "Waiting", timestamp: 10 } as ServerMessage);
      emit({ type: "sdk_event", sessionKey: "s1", event: { kind: "text", role: "assistant", text: "Progress" }, timestamp: 20 } as ServerMessage);
    });
    expect(result.current.mobileSessions[0]).toMatchObject({
      status: "running", lastActivity: "Progress", lastActivityAt: 20, pendingAttention: true,
      renderState: { components: [{ id: "status", content: "Ready" }] },
    });
    act(() => emit({ type: "wait_state", sessionKey: "s1", action: "completed", reason: "Finished", timestamp: 30 } as ServerMessage));
    expect(result.current.mobileSessions[0]).toMatchObject({ lastActivity: "Finished", pendingAttention: false });
  });

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
    const next = reduceSessionActivity({ ...emptyState(), sessions: [session({ sessionKey: "obsolete" })] }, {
      type: "session_list",
      sessions: [session({ sessionKey: "a" }), session({ sessionKey: "b" })],
    } as ServerMessage);
    expect(next.sessions.map((s) => s.sessionKey)).toEqual(["a", "b"]);
  });

  it("preserves a synced dashboard across compact session_list refreshes", () => {
    const renderState = {
      layout: { title: "Build status", columns: 1 },
      components: [{ id: "status", type: "text" as const, content: "Dashboard online" }],
    };
    const start = {
      ...emptyState(),
      sessions: [session({ sessionKey: "leader-1", status: "running", renderState })],
    };
    const next = reduceSessionActivity(start, {
      type: "session_list",
      sessions: [session({ sessionKey: "leader-1", status: "idle" })],
    } as ServerMessage);

    expect(next.sessions[0]).toMatchObject({ status: "idle", renderState });
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
      action: "started",
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

describe("review lifecycle snapshot ordering", () => {
  const dismissed = {
    reviewState: "completion_to_review" as const,
    reviewReason: "Read report", finalReport: "Done", finalDashboardRevision: null,
    dashboardRevision: 0, terminalReason: "completed" as const, terminalAt: 10,
    acknowledgedAt: null, dismissedAt: 20, lifecycleRevision: 4,
  };
  const stale = { ...dismissed, dismissedAt: null, lifecycleRevision: 3 };

  it.each(["session_list", "sync_response"] as const)(
    "does not resurrect a dismissed session from a delayed %s",
    (type) => {
      const start = { ...emptyState(), sessions: [session({ reviewLifecycle: dismissed })] };
      const message = type === "session_list"
        ? { type, sessions: [session({ reviewLifecycle: stale })] }
        : { type, sessionKey: "s1", found: true, reviewLifecycle: stale };
      const next = reduceSessionActivity(start, message as ServerMessage);
      expect(next.sessions[0]?.reviewLifecycle).toEqual(dismissed);
      const restored = { ...dismissed, dismissedAt: null, lifecycleRevision: 5 };
      const fresh = type === "session_list"
        ? { type, sessions: [session({ reviewLifecycle: restored })] }
        : { type, sessionKey: "s1", found: true, reviewLifecycle: restored };
      expect(reduceSessionActivity(next, fresh as ServerMessage).sessions[0]?.reviewLifecycle)
        .toEqual(restored);
    },
  );

  it("preserves dismissal through compact refreshes in the live hook", () => {
    let emit: (message: ServerMessage) => void = () => {};
    const subscribe = ((_topic: unknown, listener: (message: ServerMessage) => void) => {
      emit = listener;
      return () => {};
    }) as SocketSubscribe;
    const { result } = renderHook(() => useSessionActivity(subscribe));
    act(() => emit({ type: "session_list", sessions: [session({ reviewLifecycle: stale })] } as ServerMessage));
    act(() => emit({ type: "session_lifecycle_changed", sessionKey: "s1", lifecycle: dismissed, timestamp: 20 } as ServerMessage));
    act(() => emit({ type: "session_list", sessions: [session()] } as ServerMessage));
    act(() => emit({ type: "sync_response", sessionKey: "s1", found: true, reviewLifecycle: stale } as ServerMessage));
    expect(result.current.mobileSessions[0]?.reviewLifecycle).toEqual(dismissed);
  });
});


describe("wait completion attention", () => {
  it.each(["completed", "cancelled"])("clears a started wait on %s", (action) => {
    let state = reduceSessionActivity(emptyState(), {
      type: "wait_state", sessionKey: "s1", action: "started", reason: "Waiting for tasks", scheduledAt: 10,
    } as ServerMessage);
    expect(state.attention["s1"]).toBe(true);
    expect(state.activities["s1"]?.timestamp).toBe(10);
    state = reduceSessionActivity(state, {
      type: "wait_state", sessionKey: "s1", action, reason: "Wait ended", timestamp: 20,
    } as ServerMessage);
    expect(state.attention["s1"]).toBe(false);
  });
});

describe("initial session loading", () => {
  it("waits for an authoritative list even if an individual session sync arrives first", () => {
    let emit: (message: ServerMessage) => void = () => {};
    const subscribe = ((_topic: unknown, listener: typeof emit) => {
      emit = listener;
      return () => {};
    }) as SocketSubscribe;
    const { result } = renderHook(() => useSessionActivity(subscribe));
    expect(result.current.hasLoaded).toBe(false);
    act(() => emit({ type: "sync_response", found: true, sessionKey: "s1" } as ServerMessage));
    expect(result.current.hasLoaded).toBe(false);
    expect(result.current.sessions).toHaveLength(1);
    act(() => emit({ type: "session_list", sessions: [] }));
    expect(result.current.hasLoaded).toBe(true);
    expect(result.current.sessions).toEqual([]);
  });

  it("does not invalidate activity state for unrelated socket traffic", () => {
    const state = emptyState();
    expect(reduceSessionActivity(state, { type: "socket_reconnected" })).toBe(state);
  });
});
