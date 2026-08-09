import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadSystemModel } from "../system-model/load.ts";
import { getWorkPacket } from "../system-model/store.ts";
import { copyValidFixture, copyValidFixtureWithSurfaces } from "../system-model/load.test.ts";
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

  it("keeps enforced stale_blocked packets non-active until verification", async () => {
    const project = copyValidFixture();
    writeFileSync(path.join(project, ".systemmodel/policies/freshness.yaml"), [
      "freshness:",
      "  - policy_class: ordinary",
      "    consequence: block_if_unverified",
      "    required_actions: [inspect current code]",
      "",
    ].join("\n"));
    const base = makeCtx(project);
    const def = createCreateWorkPacketToolDef({
      ...base,
      runtime: { ...base.runtime, mode: "enforced" as const },
      timestampFn: async () => ({ modelTouchedAt: 10, codeTouchedAt: 20 }),
    });

    const result = await def.handler({
      userRequest: "approve workspace change",
      objectIds: ["capability.workspace_management"],
      files: ["server/session-host.ts"],
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      packet: { id: string; status: string; freshness: { status: string } };
    };

    expect(payload.packet.freshness.status).toBe("stale_blocked");
    expect(payload.packet.status).toBe("draft");
    expect(getWorkPacket(project, payload.packet.id)?.packet.status).toBe("draft");
  });

  it("passes a confirmed surface id through as a compile seed", async () => {
    const project = copyValidFixtureWithSurfaces();
    const result = await createCreateWorkPacketToolDef(makeCtx(project)).handler({
      userRequest: "mobile workspace",
      objectIds: ["surface.mobile"],
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      packet: { scope: { surfaces: string[]; capabilities: string[] } };
    };
    expect(payload.packet.scope.surfaces).toEqual(["surface.mobile"]);
    expect(payload.packet.scope.capabilities).toEqual(["capability.workspace_management"]);
  });

  it("accepts a confirmed capability and surface entry-point pair", async () => {
    const project = copyValidFixtureWithSurfaces();
    const result = await createCreateWorkPacketToolDef(makeCtx(project)).handler({
      userRequest: "update this entry point",
      entryPoints: [{
        capabilityId: "capability.workspace_management",
        surfaceId: "surface.mobile",
      }],
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      packet: { scope: { capabilities: string[]; entryPoints: Array<{ surfaceId: string }> } };
    };
    expect(payload.packet.scope.capabilities).toEqual(["capability.workspace_management"]);
    expect(payload.packet.scope.entryPoints.map((entryPoint) => entryPoint.surfaceId)).toEqual([
      "surface.canvas", "surface.mobile",
    ]);
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
