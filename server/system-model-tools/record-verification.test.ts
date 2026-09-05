vi.mock("../system-model/evidence-binding.ts", async (original) => ({
  ...await original<typeof import("../system-model/evidence-binding.ts")>(),
  captureEvidenceBinding: vi.fn(async () => "current-evidence"),
}));
import { describe, expect, it, vi } from "vitest";
import { copyValidFixture } from "../system-model/load.test.ts";
import { getWorkPacket, listWorkPacketVerifications, saveWorkPacket } from "../system-model/store.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";
import type { BusPayload } from "../bus.ts";
import { createRecordVerificationToolDef } from "./record-verification.ts";

describe("record_verification", () => {
  it("rejects invalid result", async () => {
    const project = copyValidFixture();
    const def = createRecordVerificationToolDef(makeCtx(project));
    await expect(def.handler({ workPacketId: "wp", kind: "freshness", target: "cap", result: "ok" })).rejects.toThrow();
  });

  it("persists verification rows and unblocks stale_blocked packets", async () => {
    const project = copyValidFixture();
    const emissions: BusPayload[] = [];
    saveWorkPacket(project, blockedPacket, "pack", 100);
    const def = createRecordVerificationToolDef(makeCtx(project, emissions));

    const result = await def.handler({
      workPacketId: "wp_blocked",
      kind: "freshness",
      target: "capability.workspace_management",
      result: "passed",
      notes: "inspected current code",
    });
    const payload = JSON.parse(result.content[0]!.text) as { packet: { status: string; freshness: { status: string } } };

    expect(payload.packet.status).toBe("active");
    expect(payload.packet.freshness.status).toBe("partially_stale");
    expect(getWorkPacket(project, "wp_blocked")?.packet.status).toBe("active");
    expect(listWorkPacketVerifications(project, "wp_blocked")).toHaveLength(1);
    expect(emissions.some((event) => event.type === "work_packet_verification_recorded")).toBe(true);
  });
});

const blockedPacket: WorkPacket = {
  id: "wp_blocked",
  leaderSessionKey: "leader-1",
  createdAt: 100,
  userRequest: "change workspace",
  normalizedGoal: "change workspace",
  status: "draft",
  scope: { capabilities: [], flows: [], constraints: [], decisions: [], risks: [], suggestedFiles: [], suggestedTests: [] },
  nonGoals: [],
  agentInstructions: [],
  freshness: {
    status: "stale_blocked",
    warnings: ["stale"],
    requiredVerifications: [{
      kind: "freshness",
      target: "capability.workspace_management",
      reason: "stale",
      status: "not_run",
    }],
  },
  reviewGates: [],
  riskLevel: "low",
  matchConfidence: "high",
  amendments: [],
};

function makeCtx(project: string, emissions: BusPayload[] = []) {
  return {
    leaderSessionKey: "leader-1",
    projectPath: project,
    cwd: project,
    runtime: { mode: "enforced" as const, manifestFound: true, model: null, loadErrors: [] },
    bus: { emit: () => {}, emitToSession: (_: string, payload: BusPayload) => emissions.push(payload), emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
    now: () => 200,
  };
}
