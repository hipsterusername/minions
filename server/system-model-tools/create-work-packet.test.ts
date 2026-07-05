import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { getWorkPacket } from "../system-model/store.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import type { BusPayload } from "../bus.ts";
import { createCreateWorkPacketToolDef } from "./create-work-packet.ts";

describe("create_work_packet", () => {
  it("rejects invalid input", async () => {
    const project = copyValidFixture();
    const def = createCreateWorkPacketToolDef(makeCtx(project));
    await expect(def.handler({ userRequest: "" })).rejects.toThrow();
  });

  it("compiles, persists, returns freshness, and emits creation", async () => {
    const project = copyValidFixture();
    const emissions: BusPayload[] = [];
    const def = createCreateWorkPacketToolDef(makeCtx(project, emissions));
    const result = await def.handler({
      userRequest: "approve workspace change",
      objectIds: ["capability.workspace_management"],
      files: ["server/session-host.ts"],
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      packet: { id: string; matchConfidence: string; freshness: { status: string } };
      contextPack: string;
      packetRequired: boolean;
    };

    expect(payload.packetRequired).toBe(true);
    expect(payload.packet.matchConfidence).toBe("high");
    expect(payload.packet.freshness.status).toBe("fresh");
    expect(payload.contextPack).toContain("Suggested files are hints");
    expect(getWorkPacket(project, payload.packet.id)?.contextPack).toBe(payload.contextPack);
    expect(emissions.some((event) => event.type === "work_packet_created")).toBe(true);
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
    now: () => 100,
    getHeadSha: async () => "head",
    timestampFn: async () => ({ modelTouchedAt: 20, codeTouchedAt: 10 }),
  };
}
