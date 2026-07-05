import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { getWorkPacket, saveWorkPacket } from "../system-model/store.ts";
import { compileWorkPacket } from "../system-model/compile.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import type { BusPayload } from "../bus.ts";
import { createAmendWorkPacketToolDef } from "./amend-work-packet.ts";

describe("amend_work_packet", () => {
  it("rejects missing reason", async () => {
    const project = copyValidFixture();
    const def = createAmendWorkPacketToolDef(makeCtx(project));
    await expect(def.handler({ workPacketId: "wp", reason: "", scopeDelta: {} })).rejects.toThrow();
  });

  it("recompiles scope, appends amendment, persists, and emits", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    const first = await compileWorkPacket({
      model: model!,
      cwd: project,
      headSha: "head",
      mode: "advisory",
      userRequest: "approve",
      normalizedGoal: "approve",
      matchedCandidates: [{ id: "flow.approve_changes", type: "flow", score: 6, reasons: [] }],
      matchConfidence: "high",
      timestampFn: async () => ({ modelTouchedAt: 20, codeTouchedAt: 10 }),
      now: 100,
      packetId: "wp_1",
      leaderSessionKey: "leader-1",
    });
    saveWorkPacket(project, first.packet, first.contextPack, 100);
    const emissions: BusPayload[] = [];
    const def = createAmendWorkPacketToolDef(makeCtx(project, emissions));

    const result = await def.handler({
      workPacketId: "wp_1",
      reason: "scope changed",
      scopeDelta: { addObjectIds: ["capability.workspace_management"] },
    });
    const payload = JSON.parse(result.content[0]!.text) as { packet: { amendments: unknown[]; status: string } };

    expect(payload.packet.status).toBe("amended");
    expect(payload.packet.amendments).toHaveLength(1);
    expect(getWorkPacket(project, "wp_1")?.packet.amendments).toHaveLength(1);
    expect(emissions.some((event) => event.type === "work_packet_amended")).toBe(true);
  });
});

function makeCtx(project: string, emissions: BusPayload[] = []) {
  const { model } = loadSystemModel(project);
  return {
    leaderSessionKey: "leader-1",
    projectPath: project,
    cwd: project,
    runtime: { mode: "advisory" as const, manifestFound: true, model, loadErrors: [] },
    bus: { emit: () => {}, emitToSession: (_: string, payload: BusPayload) => emissions.push(payload), emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
    now: () => 200,
    getHeadSha: async () => "head",
    timestampFn: async () => ({ modelTouchedAt: 20, codeTouchedAt: 10 }),
  };
}
