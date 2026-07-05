import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { attachConnectionListeners } from "../../server/ws-connection.ts";
import type { ConnectionDeps } from "../../server/ws-connection.ts";
import { dispatchCommand } from "../../server/commands/index.ts";
import { cmd, setup } from "../../server/commands/test-harness.ts";
import { copyValidFixture } from "../../server/system-model/load.test.ts";
import { getWorkPacket, saveWorkPacket } from "../../server/system-model/store.ts";
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

describe("contract: waive_review_gate", () => {
  it("dispatches valid waive_review_gate commands", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, deps(dispatch));
    ws.sent = [];

    send(ws, {
      type: "waive_review_gate",
      sessionKey: "leader-1",
      gateId: "gate.review",
      reason: "human accepted risk",
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].type).toBe("waive_review_gate");
  });

  it("rejects malformed waive_review_gate commands before dispatch", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, deps(dispatch));
    ws.sent = [];

    send(ws, { type: "waive_review_gate", sessionKey: "leader-1", gateId: "gate.review" });

    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent[0]!).type).toBe("error");
  });

  it("persists a human waiver through the command handler", () => {
    const project = copyValidFixture();
    saveWorkPacket(project, packet, "context", 2);
    const h = setup({ cwd: project });

    dispatchCommand(
      h.ctx,
      cmd({
        type: "waive_review_gate",
        gateId: "gate.review",
        reason: "human accepted risk",
      }),
      h.ws,
    );

    const ack = h.wsSent.find((event) => event.type === "control_response");
    expect(ack).toMatchObject({ success: true, gateId: "gate.review" });
    expect(getWorkPacket(project, packet.id)?.packet.reviewGates[0]).toMatchObject({
      status: "waived",
      reason: "human accepted risk",
    });
  });
});

const packet: WorkPacket = {
  id: "wp_waive",
  leaderSessionKey: "leader-1",
  createdAt: 1,
  userRequest: "change server command",
  normalizedGoal: "change server command",
  status: "active",
  scope: { capabilities: [], flows: [], constraints: [], decisions: [], risks: [], suggestedFiles: [], suggestedTests: [] },
  nonGoals: [],
  agentInstructions: [],
  freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
  reviewGates: [{ gateId: "gate.review", name: "Human Review", status: "required_pending", reason: "pending" }],
  riskLevel: "high",
  matchConfidence: "high",
  amendments: [],
};
