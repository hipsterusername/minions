/**
 * sync_session — return a snapshot of one session plus its buffered events.
 *
 * Used by the client on reconnect; if the session has render state, it
 * also re-emits `render_update` so the dashboard rehydrates.
 */
import { describe, expect, it } from "vitest";
import type { BufferedEvent } from "../session-host.ts";
import { syncSession } from "./sync-session.ts";
import { setup, cmd } from "./test-harness.ts";

describe("sync_session", () => {
  it("emits sync_response with found=false when the session is unknown", () => {
    const h = setup();
    syncSession(
      h.ctx,
      cmd({ type: "sync_session", sessionKey: "ghost" }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["topic"]).toBe("session:ghost");
    expect(h.wsSent[0]!["type"]).toBe("sync_response");
    expect(h.wsSent[0]!["found"]).toBe(false);
  });

  it("returns the host snapshot under sync_response with documented fields", () => {
    const h = setup();
    h.host.status = "running";
    h.host.sessionId = "sdk-id";
    h.host.totalCost = 0.5;
    h.host.turns = 3;
    h.host.model = "sonnet";
    h.host.permissionMode = "auto";
    h.host.taskName = "Audit";
    h.host.role = "leader";
    const event: BufferedEvent = {
      type: "session_status",
      sessionKey: "leader-1",
      status: "running",
      timestamp: 1,
    };
    h.host.eventBuffer.push(event);

    syncSession(h.ctx, cmd({ type: "sync_session" }), h.ws);

    expect(h.wsSent).toHaveLength(1);
    const env = h.wsSent[0]!;
    expect(env["found"]).toBe(true);
    expect(env["status"]).toBe("running");
    expect(env["sessionId"]).toBe("sdk-id");
    expect(env["totalCost"]).toBe(0.5);
    expect(env["turns"]).toBe(3);
    expect(env["model"]).toBe("sonnet");
    expect(env["permissionMode"]).toBe("auto");
    expect(env["taskName"]).toBe("Audit");
    expect(env["role"]).toBe("leader");
    expect(env["events"]).toEqual([event]);
  });

  it("sync_response carries the host's harness and capabilities", () => {
    const h = setup();
    h.host.harnessName = "echo";

    syncSession(h.ctx, cmd({ type: "sync_session" }), h.ws);

    expect(h.wsSent).toHaveLength(1);
    const env = h.wsSent[0]!;
    expect(env["harness"]).toBe("echo");
    const caps = env["harnessCapabilities"] as Record<string, unknown>;
    expect(caps).not.toBeNull();
    // EchoHarness declares every capability false.
    expect(caps["thinking"]).toBe(false);
    expect(caps["mcp"]).toBe(false);
    expect(caps["builtInFilesystem"]).toBe(false);
  });

  it("sync_response sets harnessCapabilities=null when the harness is not registered", () => {
    const h = setup();
    h.host.harnessName = "ghost-harness-not-loaded";

    syncSession(h.ctx, cmd({ type: "sync_session" }), h.ws);

    const env = h.wsSent[0]!;
    expect(env["harness"]).toBe("ghost-harness-not-loaded");
    expect(env["harnessCapabilities"]).toBeNull();
  });

  it("re-emits render_update when the host has non-empty renderState", () => {
    const h = setup();
    h.host.renderState = {
      title: "Dashboard",
      columns: 3,
      gap: 12,
      components: [{ id: "a", type: "metric", label: "X", value: "1" }],
    };

    syncSession(h.ctx, cmd({ type: "sync_session" }), h.ws);

    // Two unicasts: sync_response, then render_update.
    expect(h.wsSent).toHaveLength(2);
    expect(h.wsSent[1]!["type"]).toBe("render_update");
    expect(h.wsSent[1]!["action"]).toBe("set");
    expect(h.wsSent[1]!["components"]).toHaveLength(1);
  });

  it("does NOT re-emit render_update when renderState is empty", () => {
    const h = setup();
    h.host.renderState = {
      title: "",
      columns: 2,
      gap: 12,
      components: [],
    };
    syncSession(h.ctx, cmd({ type: "sync_session" }), h.ws);
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("sync_response");
  });

  it("derives activeMinions from taskState by filtering planned + running entries", () => {
    const h = setup();
    h.host.taskState = {
      tasks: new Map([
        [
          "t1",
          {
            taskId: "t1",
            title: "Plan",
            description: "",
            priority: "medium",
            executor: "leader",
            minionSessionKey: null,
            leaderSessionKey: "leader-1",
            status: "planned",
            createdAt: 0,
            completedAt: null,
            result: null,
          },
        ],
        [
          "t2",
          {
            taskId: "t2",
            title: "Run",
            description: "",
            priority: "high",
            executor: "minion",
            minionSessionKey: "m-1",
            leaderSessionKey: "leader-1",
            status: "running",
            createdAt: 0,
            completedAt: null,
            result: null,
          },
        ],
        [
          "t3",
          {
            taskId: "t3",
            title: "Done",
            description: "",
            priority: "low",
            executor: "leader",
            minionSessionKey: null,
            leaderSessionKey: "leader-1",
            status: "completed",
            createdAt: 0,
            completedAt: 1,
            result: "ok",
          },
        ],
      ]),
      pendingWait: null,
      approval: null,
    };

    syncSession(h.ctx, cmd({ type: "sync_session" }), h.ws);

    const env = h.wsSent[0]!;
    const active = env["activeMinions"] as Array<{ taskId: string }>;
    expect(active.map((m) => m.taskId).sort()).toEqual(["t1", "t2"]);
  });

  it("is a no-op (no unicast) when sessionKey is missing", () => {
    const h = setup();
    syncSession(
      h.ctx,
      cmd({ type: "sync_session", sessionKey: undefined }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(0);
  });
});
