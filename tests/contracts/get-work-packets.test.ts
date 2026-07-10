import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { attachConnectionListeners } from "../../server/ws-connection.ts";
import type { ConnectionDeps } from "../../server/ws-connection.ts";
import { dispatchCommand } from "../../server/commands/index.ts";
import { cmd, setup } from "../support/server-command-harness.ts";
import { saveWorkPacket } from "../../server/system-model/store.ts";
import { copyValidFixture } from "../../server/system-model/load.test.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

function deps(dispatch = vi.fn()): ConnectionDeps {
  return { snapshotSessions: () => [], dispatch };
}

function send(ws: FakeWs, payload: unknown): void {
  ws.emit("message", Buffer.from(JSON.stringify(payload)));
}

describe("contract: get_work_packets", () => {
  it("dispatches valid get_work_packets commands", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, deps(dispatch));
    ws.sent = [];

    send(ws, { type: "get_work_packets", sessionKey: "leader-1" });
    send(ws, { type: "get_work_packets", projectPath: "/tmp/project", workPacketId: "wp_1" });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((call) => call[0].type)).toEqual([
      "get_work_packets",
      "get_work_packets",
    ]);
  });

  it("rejects malformed get_work_packets commands before dispatch", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, deps(dispatch));
    ws.sent = [];

    send(ws, { type: "get_work_packets", projectPath: 42 });

    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0]!).type).toBe("error");
  });

  it("lists packets for a session", () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet("wp_1", "leader-1"), "context one", 2);
    saveWorkPacket(project, packet("wp_2", "other"), "context two", 3);
    const h = setup({ cwd: project });

    dispatchCommand(h.ctx, cmd({ type: "get_work_packets" }), h.ws);

    const response = h.wsSent[0] as {
      packets?: Array<{ packet: { id: string }; contextPack: string }>;
    };
    expect(response.packets?.map((item) => item.packet.id)).toEqual(["wp_1"]);
    expect(response.packets?.[0]?.contextPack).toBe("context one");
  });

  it("returns detail by packet id for a project", () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet("wp_1", "leader-1"), "context one", 2);
    saveWorkPacket(project, packet("wp_2", "leader-1"), "context two", 3);
    const h = setup({ cwd: project });

    dispatchCommand(
      h.ctx,
      cmd({ type: "get_work_packets", sessionKey: undefined, projectPath: project, workPacketId: "wp_2" }),
      h.ws,
    );

    const response = h.wsSent[0] as {
      packets?: Array<{ packet: { id: string }; contextPack: string }>;
    };
    expect(response.packets?.map((item) => item.packet.id)).toEqual(["wp_2"]);
    expect(response.packets?.[0]?.contextPack).toBe("context two");
  });
});

function packet(id: string, leaderSessionKey: string): WorkPacket {
  return {
    id,
    leaderSessionKey,
    createdAt: 1,
    userRequest: "request",
    normalizedGoal: "request",
    status: "active",
    scope: {
      capabilities: [],
      flows: [],
      constraints: [],
      decisions: [],
      risks: [],
      suggestedFiles: [],
      suggestedTests: [],
    },
    nonGoals: [],
    agentInstructions: [],
    freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
    reviewGates: [],
    riskLevel: "low",
    matchConfidence: "high",
    amendments: [],
  };
}
