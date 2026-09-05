import { useEffect, useMemo, useState } from "react";

import type { ServerMessage, SessionInfo, SocketSubscribe } from "./use-socket.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import { applyRenderMessage, renderMessageSchema } from "../shared/render-dsl.ts";

/**
 * Shared session-activity derivation.
 *
 * Both the mobile Activity screen and the desktop Activity view present the
 * same picture: the live list of sessions, each enriched with its most recent
 * activity line and an "attention" flag. This hook owns that derivation so the
 * two surfaces stay byte-for-byte consistent — it subscribes to the socket
 * firehose, tracks the session list + per-session activity/attention, and
 * returns both the raw `SessionInfo[]` (needed for approvals) and the enriched
 * `MobileSessionInfo[]`.
 */

type AttentionMap = Record<string, boolean>;
type ActivityMap = Record<string, { text: string; timestamp: number }>;

export interface SessionActivityState {
  /** Raw session list as last broadcast by the server. */
  sessions: SessionInfo[];
  /** Sessions enriched with `lastActivity` / `lastActivityAt` / `pendingAttention`. */
  mobileSessions: MobileSessionInfo[];
}

function sessionWithStatus(session: SessionInfo, status: string): SessionInfo {
  return { ...session, status };
}

function sessionWithSyncResponse(session: SessionInfo, msg: Extract<ServerMessage, { type: "sync_response" }>): SessionInfo {
  return {
    ...session,
    ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
    ...(msg.status ? { status: msg.status } : {}),
    ...(msg.cwd ? { cwd: msg.cwd } : {}),
    ...(msg.totalCost !== undefined ? { totalCost: msg.totalCost } : {}),
    ...(msg.turns !== undefined ? { turns: msg.turns } : {}),
    ...(msg.usageTotals !== undefined ? { usageTotals: msg.usageTotals } : {}),
    ...(msg.model !== undefined ? { model: msg.model } : {}),
    ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
    ...(msg.taskName !== undefined ? { taskName: msg.taskName } : {}),
    ...(msg.role !== undefined ? { role: msg.role } : {}),
    ...(msg.harness !== undefined ? { harness: msg.harness } : {}),
    ...(msg.harnessCapabilities !== undefined ? { harnessCapabilities: msg.harnessCapabilities } : {}),
    ...(msg.taskPlan !== undefined ? { taskPlan: msg.taskPlan } : {}),
    ...(msg.activeMinions !== undefined ? { activeMinions: msg.activeMinions } : {}),
    ...(msg.renderState !== undefined ? { renderState: msg.renderState } : {}),
    ...(msg.reviewLifecycle !== undefined &&
      msg.reviewLifecycle.lifecycleRevision >= (session.reviewLifecycle?.lifecycleRevision ?? -1)
      ? { reviewLifecycle: msg.reviewLifecycle } : {}),
  };
}

function sessionFromSyncResponse(msg: Extract<ServerMessage, { type: "sync_response" }>): SessionInfo {
  return sessionWithSyncResponse(
    {
      sessionKey: msg.sessionKey,
      sessionId: msg.sessionId ?? null,
      status: msg.status ?? "idle",
      cwd: msg.cwd ?? "",
    },
    msg,
  );
}

function sessionsWithSyncResponse(
  sessions: SessionInfo[],
  msg: Extract<ServerMessage, { type: "sync_response" }>,
): SessionInfo[] {
  let found = false;
  const next = sessions.map((session) => {
    if (session.sessionKey !== msg.sessionKey) return session;
    found = true;
    return sessionWithSyncResponse(session, msg);
  });
  return found ? next : [...next, sessionFromSyncResponse(msg)];
}

/**
 * The registry's session_list payload is deliberately compact and does not
 * include dashboard render state. Keep render state learned from sync_response
 * or render_update while still treating the incoming list as authoritative for
 * membership. Lifecycle state is revisioned: delayed snapshots must not undo
 * a newer dismissal, acknowledgement, or restore learned from a live event.
 */
function sessionsFromList(
  current: SessionInfo[],
  incoming: SessionInfo[],
): SessionInfo[] {
  const currentByKey = new Map(current.map((session) => [session.sessionKey, session]));
  return incoming.map((session) => {
    const prior = currentByKey.get(session.sessionKey);
    return {
      ...session,
      ...(session.renderState === undefined && prior?.renderState !== undefined
        ? { renderState: prior.renderState } : {}),
      ...(prior?.reviewLifecycle && prior.reviewLifecycle.lifecycleRevision >
        (session.reviewLifecycle?.lifecycleRevision ?? -1)
        ? { reviewLifecycle: prior.reviewLifecycle } : {}),
    };
  });
}

function sessionWithRenderUpdate(session: SessionInfo, msg: Extract<ServerMessage, { type: "render_update" }>): SessionInfo {
  const parsed = renderMessageSchema.safeParse(msg);
  if (!parsed.success) return session;
  const current = session.renderState ?? { layout: { columns: 2, gap: 12 }, components: [] };
  return { ...session, renderState: applyRenderMessage(current, parsed.data) };
}

/**
 * Extract a per-session activity update from a server message, or `null` if the
 * message carries no activity signal. `attention` is left `undefined` when the
 * message should not change the attention flag (vs. `false`, which clears it).
 */
export function activityFromMessage(
  msg: ServerMessage,
): { sessionKey: string; text: string; timestamp: number; attention?: boolean } | null {
  switch (msg.type) {
    case "minion_status":
      return {
        sessionKey: msg.minionSessionKey,
        text: msg.message,
        timestamp: msg.timestamp,
        attention: msg.trigger === "fail",
      };
    case "agent_task_update":
      return {
        sessionKey: msg.leaderSessionKey,
        text: msg.summary ?? `Task ${msg.status}`,
        timestamp: msg.timestamp,
      };
    case "wait_state":
      return {
        sessionKey: msg.sessionKey,
        text: msg.reason,
        timestamp: msg.timestamp ?? msg.scheduledAt ?? Date.now(),
        attention: msg.action === "started",
      };
    case "approval_requested":
      return {
        sessionKey: msg.sessionKey,
        text: msg.summary,
        timestamp: msg.timestamp,
        attention: true,
      };
    case "approval_resolved":
      return {
        sessionKey: msg.sessionKey,
        text: `Approval ${msg.action}`,
        timestamp: msg.timestamp,
        attention: false,
      };
    case "worktree_merged":
      return {
        sessionKey: msg.sessionKey,
        text: "Worktree merged",
        timestamp: Date.now(),
        attention: false,
      };
    case "session_completed":
      return {
        sessionKey: msg.sessionKey,
        text: msg.reason,
        timestamp: msg.timestamp,
        attention: false,
      };
    case "sdk_event":
      if (msg.event.kind === "text" && msg.event.role === "assistant") {
        return {
          sessionKey: msg.sessionKey,
          text: msg.event.text.replace(/<!--task-name:.+?-->\s*/g, "").trim(),
          timestamp: msg.timestamp ?? Date.now(),
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Pure reducer step — fold one server message into the prior maps + session
 * list. Exported for testing; the hook wires this to the live socket.
 */
export function reduceSessionActivity(
  prev: { sessions: SessionInfo[]; activities: ActivityMap; attention: AttentionMap },
  msg: ServerMessage,
): { sessions: SessionInfo[]; activities: ActivityMap; attention: AttentionMap } {
  let { sessions, activities, attention } = prev;

  if (msg.type === "session_list") {
    return { sessions: sessionsFromList(sessions, msg.sessions), activities, attention };
  }

  if (msg.type === "session_status") {
    sessions = sessions.map((session) =>
      session.sessionKey === msg.sessionKey
        ? sessionWithStatus(session, msg.status)
        : session,
    );
  }

  if (msg.type === "sync_response" && msg.found) {
    sessions = sessionsWithSyncResponse(sessions, msg);
  }

  if (msg.type === "task_plan_update") {
    sessions = sessions.map((session) =>
      session.sessionKey === msg.leaderSessionKey
        ? { ...session, taskPlan: msg.tasks }
        : session,
    );
  }

  if (msg.type === "render_update") {
    sessions = sessions.map((session) =>
      session.sessionKey === msg.leaderSessionKey
        ? sessionWithRenderUpdate(session, msg)
        : session,
    );
  }

  if (msg.type === "session_lifecycle_changed") {
    sessions = sessions.map((session) =>
      session.sessionKey === msg.sessionKey &&
      (session.reviewLifecycle?.lifecycleRevision ?? -1) < msg.lifecycle.lifecycleRevision
        ? { ...session, reviewLifecycle: msg.lifecycle }
        : session,
    );
  }

  const activity = activityFromMessage(msg);
  if (!activity) return { sessions, activities, attention };

  if (activity.text) {
    activities = {
      ...activities,
      [activity.sessionKey]: { text: activity.text, timestamp: activity.timestamp },
    };
  }

  if (activity.attention !== undefined) {
    attention = { ...attention, [activity.sessionKey]: activity.attention === true };
  }

  return { sessions, activities, attention };
}

/**
 * Subscribe to the socket firehose and derive the enriched session-activity
 * state. The subscription is set up once per `subscribe` identity.
 */
export function useSessionActivity(subscribe: SocketSubscribe): SessionActivityState {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activities, setActivities] = useState<ActivityMap>({});
  const [attention, setAttention] = useState<AttentionMap>({});

  useEffect(() => {
    return subscribe("*", (msg) => {
      if (msg.type === "session_list") {
        setSessions((current) => sessionsFromList(current, msg.sessions));
        return;
      }

      if (msg.type === "session_status") {
        setSessions((current) =>
          current.map((session) =>
            session.sessionKey === msg.sessionKey
              ? sessionWithStatus(session, msg.status)
              : session,
          ),
        );
      }

      if (msg.type === "sync_response" && msg.found) {
        setSessions((current) => sessionsWithSyncResponse(current, msg));
      }

      if (msg.type === "task_plan_update") {
        setSessions((current) =>
          current.map((session) =>
            session.sessionKey === msg.leaderSessionKey
              ? { ...session, taskPlan: msg.tasks }
              : session,
          ),
        );
      }

      if (msg.type === "render_update") {
        setSessions((current) =>
          current.map((session) =>
            session.sessionKey === msg.leaderSessionKey
              ? sessionWithRenderUpdate(session, msg)
              : session,
          ),
        );
      }


      if (msg.type === "session_lifecycle_changed") {
        setSessions((current) => current.map((session) =>
          session.sessionKey === msg.sessionKey &&
          (session.reviewLifecycle?.lifecycleRevision ?? -1) < msg.lifecycle.lifecycleRevision
            ? { ...session, reviewLifecycle: msg.lifecycle }
            : session,
        ));
      }

      const activity = activityFromMessage(msg);
      if (!activity) return;

      if (activity.text) {
        setActivities((current) => ({
          ...current,
          [activity.sessionKey]: { text: activity.text, timestamp: activity.timestamp },
        }));
      }

      if (activity.attention !== undefined) {
        setAttention((current) => ({
          ...current,
          [activity.sessionKey]: activity.attention === true,
        }));
      }
    });
  }, [subscribe]);

  const mobileSessions = useMemo<MobileSessionInfo[]>(
    () =>
      sessions.map((session) => ({
        ...session,
        lastActivity: activities[session.sessionKey]?.text ?? null,
        lastActivityAt: activities[session.sessionKey]?.timestamp ?? session.lastActivityAt ?? null,
        pendingAttention: attention[session.sessionKey] === true,
      })),
    [activities, attention, sessions],
  );

  return { sessions, mobileSessions };
}
