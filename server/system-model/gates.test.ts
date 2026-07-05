import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetailedDiff, WorktreeInfo } from "../worktree-types.ts";
import type { SessionHost } from "../session-host.ts";

const diffMock = vi.fn(async (): Promise<DetailedDiff> => diffFor(["server/commands/helpers.ts"]));

vi.mock("../worktree.ts", () => ({
  getDetailedDiff: () => diffMock(),
}));

import { openProjectDb, writeSettings } from "../project-store.ts";
import { recordWorkPacketVerification, saveWorkPacket } from "./store.ts";
import { copyValidFixture } from "./load.test.ts";
import { evaluateMergeGates } from "./gates.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";

beforeEach(() => {
  diffMock.mockClear();
  diffMock.mockResolvedValue(diffFor(["server/commands/helpers.ts"]));
});

describe("evaluateMergeGates", () => {
  it("does not inspect the diff when the system model is off", async () => {
    const project = copyValidFixture();

    const verdict = await evaluateMergeGates(host(project));

    expect(verdict).toEqual({ allowed: true, mode: "off", gates: [] });
    expect(diffMock).not.toHaveBeenCalled();
  });

  it("marks gates not_required when the actual diff misses required_when globs", async () => {
    const project = enabledProject();
    diffMock.mockResolvedValue(diffFor(["README.md"]));

    const verdict = await evaluateMergeGates(host(project));

    expect(verdict.allowed).toBe(true);
    expect(verdict.gates[0]).toMatchObject({ id: "gate.review", status: "not_required" });
  });

  it("marks required gates pending until a matching packet is reconciled", async () => {
    const project = enabledProject();

    const verdict = await evaluateMergeGates(host(project));

    expect(verdict.allowed).toBe(false);
    expect(verdict.gates[0]).toMatchObject({ id: "gate.review", status: "required_pending" });
  });

  it("honors persisted packet waivers", async () => {
    const project = enabledProject();
    saveWorkPacket(project, packet({ gateStatus: "waived", gateReason: "owner accepted risk" }), "");

    const verdict = await evaluateMergeGates(host(project));

    expect(verdict.allowed).toBe(true);
    expect(verdict.gates[0]).toMatchObject({
      id: "gate.review",
      status: "waived",
      reason: "owner accepted risk",
    });
  });

  it("uses reconciliation gate failures as failing verdicts", async () => {
    const project = enabledProject();
    saveWorkPacket(project, packet(), "");
    saveReport(project, "failed", "constraint violated");

    const verdict = await evaluateMergeGates(host(project));

    expect(verdict.allowed).toBe(false);
    expect(verdict.gates[0]).toMatchObject({ status: "failed", reason: "constraint violated" });
  });

  it("passes when reconciliation and verification rows pass", async () => {
    const project = enabledProject();
    saveWorkPacket(project, packet(), "");
    saveReport(project, "required_pending", "checked by reviewer");
    recordWorkPacketVerification(project, {
      workPacketId: "wp_1",
      kind: "test",
      target: "server/commands/merge-flow.test.ts",
      result: "passed",
      notes: null,
      recordedAt: 2,
    });

    const verdict = await evaluateMergeGates(host(project));

    expect(verdict.allowed).toBe(true);
    expect(verdict.gates[0]).toMatchObject({ status: "passed" });
  });

  it("fails when any verification row failed", async () => {
    const project = enabledProject();
    saveWorkPacket(project, packet(), "");
    saveReport(project, "required_pending", "checked by reviewer");
    recordWorkPacketVerification(project, {
      workPacketId: "wp_1",
      kind: "test",
      target: "server/commands/merge-flow.test.ts",
      result: "failed",
      notes: null,
      recordedAt: 2,
    });

    const verdict = await evaluateMergeGates(host(project));

    expect(verdict.allowed).toBe(false);
    expect(verdict.gates[0]).toMatchObject({ status: "failed" });
  });
});

function enabledProject(): string {
  const project = copyValidFixture();
  writeSettings(project, { systemModel: "advisory" });
  return project;
}

function host(project: string): SessionHost {
  const worktree: WorktreeInfo = {
    path: project,
    branch: "canvas/k",
    leaderSessionKey: "leader-1",
    createdAt: 1,
    projectPath: project,
    lifecycle: "active",
  };
  return { id: "leader-1", cwd: project, worktree } as SessionHost;
}

function diffFor(files: string[]): DetailedDiff {
  return {
    filesChanged: files.length,
    insertions: 1,
    deletions: 0,
    files: files.map((file) => ({ file, insertions: 1, deletions: 0, status: "modified" })),
    commits: [],
    branch: "canvas/k",
  };
}

function packet(opts?: {
  gateStatus?: WorkPacket["reviewGates"][number]["status"];
  gateReason?: string;
}): WorkPacket {
  return {
    id: "wp_1",
    leaderSessionKey: "leader-1",
    createdAt: 1,
    userRequest: "change server command",
    normalizedGoal: "change server command",
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
    reviewGates: [{
      gateId: "gate.review",
      name: "Human Review",
      status: opts?.gateStatus ?? "required_pending",
      reason: opts?.gateReason ?? "required",
    }],
    riskLevel: "high",
    matchConfidence: "high",
    amendments: [],
  };
}

function saveReport(project: string, status: WorkPacket["reviewGates"][number]["status"], reason: string): void {
  openProjectDb(project).prepare(
    `INSERT INTO reconciliation_reports (id, work_packet_id, report_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run("rec_1", "wp_1", JSON.stringify({
    id: "rec_1",
    workPacketId: "wp_1",
    createdAt: 2,
    deterministic: {
      provenance: "deterministic",
      changedFiles: ["server/commands/helpers.ts"],
      gateRequirements: [{
        gateId: "gate.review",
        name: "Human Review",
        status,
        reason,
      }],
    },
    provenance: { deterministic: "deterministic" },
    affectedObjects: [],
    changedFiles: ["server/commands/helpers.ts"],
    gates: [{ gateId: "gate.review", name: "Human Review", status, reason }],
    constraintChecks: [],
  }), 2);
}
