import { describe, expect, it } from "vitest";
import type { BusPayload } from "../bus.ts";
import { loadSystemModel } from "../system-model/load.ts";
import { copyValidFixture } from "../system-model/load.test.ts";
import { getWorkPacket, saveWorkPacket } from "../system-model/store.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";
import { createRecordWorkPacketEvidenceToolDef } from "./record-work-packet-evidence.ts";

describe("record_work_packet_evidence", () => {
  it("appends evidence, advances criterion coverage, resolves its gap, and refreshes context", async () => {
    const project = copyValidFixture();
    const emissions: BusPayload[] = [];
    saveWorkPacket(project, packet, "old context", 1);

    const result = await createRecordWorkPacketEvidenceToolDef(makeCtx(project, emissions)).handler({
      workPacketId: packet.id,
      evidence: [{
        id: "evidence-focused-tests",
        kind: "observation",
        summary: "Focused tests passed",
        criterionIds: ["criterion-1"],
        evidenceRefs: ["server/example.test.ts"],
      }],
      coverageUpdates: [{
        criterionId: "criterion-1",
        status: "verified",
        evidenceRefs: ["server/example.test.ts"],
      }],
      signalUpdates: [],
    });
    const payload = JSON.parse(result.content[0]!.text) as {
      packet: WorkPacket;
      contextPack: string;
      openSignals: unknown[];
    };

    expect(payload.packet.evidenceLedger).toEqual([
      expect.objectContaining({ id: "evidence-focused-tests", provenance: "leader_observed" }),
    ]);
    expect(payload.packet.criterionCoverage?.[0]).toMatchObject({ status: "verified" });
    expect(payload.packet.signals?.[0]).toMatchObject({ status: "addressed" });
    expect(payload.openSignals).toEqual([]);
    expect(payload.contextPack).toContain("Criterion criterion-1 [verified]");
    expect(payload.contextPack).toContain("Evidence evidence-focused-tests");
    expect(getWorkPacket(project, packet.id)?.contextPack).toBe(payload.contextPack);
    expect(emissions.map((event) => event.type)).toContain("work_packet_evidence_recorded");
  });

  it("rejects evidence replacement and unsupported coverage claims", async () => {
    const project = copyValidFixture();
    saveWorkPacket(project, {
      ...packet,
      evidenceLedger: [{
        id: "evidence-existing",
        kind: "claim",
        summary: "Existing claim",
        criterionIds: [],
        objectIds: [],
        evidenceRefs: [],
        provenance: "minion_reported",
        createdAt: 1,
      }],
    }, "context", 1);
    const def = createRecordWorkPacketEvidenceToolDef(makeCtx(project));

    await expect(def.handler({
      workPacketId: packet.id,
      evidence: [{ id: "evidence-existing", kind: "claim", summary: "Replacement" }],
    })).rejects.toThrow(/append-only/);
    await expect(def.handler({
      workPacketId: packet.id,
      coverageUpdates: [{ criterionId: "criterion-1", status: "verified" }],
    })).rejects.toThrow(/requires evidence/);
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
  };
}

const packet: WorkPacket = {
  id: "wp_evidence_tool",
  leaderSessionKey: "leader-1",
  createdAt: 1,
  userRequest: "request",
  normalizedGoal: "request",
  status: "active",
  scope: {
    capabilities: ["capability.workspace_management"],
    flows: [], constraints: ["constraint.bus_only"], decisions: [], risks: [],
    suggestedFiles: ["server/session-host.ts"], suggestedTests: ["server/example.test.ts"],
  },
  nonGoals: [],
  agentInstructions: [],
  freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
  reviewGates: [],
  riskLevel: "high",
  matchConfidence: "high",
  criterionCoverage: [{
    criterionId: "criterion-1",
    criterion: "Focused tests pass",
    status: "open",
    objectIds: [],
    evidenceRefs: [],
    provenance: "human",
    updatedAt: 1,
  }],
  evidenceLedger: [],
  signals: [{
    id: "signal.coverage_gap.criterion-1",
    type: "coverage_gap",
    priority: "high",
    status: "open",
    summary: "Acceptance criterion lacks evidence",
    criterionIds: ["criterion-1"],
    objectIds: [],
    evidenceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  }],
  amendments: [],
};
