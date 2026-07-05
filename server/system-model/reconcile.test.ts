import { describe, expect, it } from "vitest";
import type { WorkPacket } from "../../shared/system-model/index.ts";
import type { DetailedDiff } from "../worktree-types.ts";
import { loadSystemModel } from "./load.ts";
import { reconcileDeterministic } from "./reconcile.ts";

describe("reconcileDeterministic", () => {
  it("maps changed files to affected scope, gates, missing tests, and drift", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const report = reconcileDeterministic({ model, packet, diff });

    expect(report).toMatchObject({
      provenance: "deterministic",
      changedFiles: ["server/commands/approve-changes.ts", "server/session-host.ts", "src/Canvas.tsx"],
      affectedCapabilities: ["capability.workspace_management"],
      affectedFlows: ["flow.approve_changes"],
      constraintsInScope: ["constraint.bus_only"],
      testsMissing: ["server/session-host.test.ts"],
      outOfScopeFiles: ["server/commands/approve-changes.ts", "src/Canvas.tsx"],
    });
    expect(report.gateRequirements[0]).toMatchObject({
      gateId: "gate.review",
      status: "required_pending",
    });
  });

  it("never emits minion verdict statuses from deterministic code", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    const report = reconcileDeterministic({ model, packet, diff });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("appears_satisfied");
    expect(serialized).not.toContain("possibly_violated");
    expect(serialized).not.toContain("violated");
    expect(serialized).not.toContain("not_checked");
    expect(serialized).not.toContain("minion_judged");
  });
});

const packet: WorkPacket = {
  id: "wp_reconcile",
  leaderSessionKey: "leader-1",
  createdAt: 1,
  userRequest: "request",
  normalizedGoal: "request",
  status: "amended",
  scope: {
    capabilities: ["capability.workspace_management"],
    flows: [],
    constraints: ["constraint.bus_only"],
    decisions: [],
    risks: [],
    suggestedFiles: ["server/session-host.ts"],
    suggestedTests: ["server/session-host.test.ts"],
  },
  nonGoals: [],
  agentInstructions: ["Use Bus helpers, never direct broadcast."],
  freshness: { status: "fresh", warnings: [], requiredVerifications: [] },
  reviewGates: [],
  riskLevel: "high",
  matchConfidence: "high",
  amendments: [{ at: 2, reason: "final scope", delta: "include actual files" }],
};

const diff: DetailedDiff = {
  filesChanged: 3,
  insertions: 12,
  deletions: 3,
  branch: "work",
  commits: ["abc change"],
  files: [
    { file: "server/session-host.ts", insertions: 5, deletions: 1, status: "modified" },
    { file: "server/commands/approve-changes.ts", insertions: 7, deletions: 2, status: "modified" },
    { file: "src/Canvas.tsx", insertions: 0, deletions: 0, status: "modified" },
  ],
};
