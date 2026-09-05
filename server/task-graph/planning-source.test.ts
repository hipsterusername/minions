import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSkills } from "../../shared/skill-prompt.ts";
import { saveSkillSnapshot } from "../skill-snapshot.ts";
import "./test-helpers.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticTaskGraphPlan } from "../../shared/task-graph-planning-contracts.ts";

vi.mock("../skills.ts", () => ({
  loadSkillsByIds: () => [],
  compileSkills: (skills: import("../skills.ts").SkillTemplate[], values: Record<string, Record<string, string>>) => compileSkills(skills, values),
}));
const mocks = vi.hoisted(() => ({ storedPacket: null as null | {
  packet: { id: string; reviewGates: Array<{ gateId: string; name: string;
    status: string; reason: string }>; freshness: { status: string } };
  contextPack: string;
} }));
vi.mock("../project-store.ts", () => ({ readSettings: () => ({ systemModel: "off" }) }));
vi.mock("../system-model/load.ts", () => ({
  loadSystemModel: () => ({ model: null, errors: [] }),
}));
vi.mock("../system-model/store.ts", () => ({ getWorkPacket: () => mocks.storedPacket }));
vi.mock("../system-model/applicability.ts", () => ({
  computePacketApplicability: () => ({ packetRequired: false, gateHits: [], constraintHits: [] }),
}));

import { capturePlanningSource, type PlanningSourceContext } from "./planning-source.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function plan(selectors: string[]): SemanticTaskGraphPlan {
  return {
    objective: "Implement the change",
    acceptanceCriteria: ["done"],
    nonGoals: [], constraints: [], assumptions: [], questions: [], maxActiveAttempts: 1,
    steps: [{
      key: "build", title: "Build", objective: "Build it", acceptanceCriteria: ["passes"],
      constraints: [], dependsOn: [], contextSelectors: selectors, inputBindings: {},
      outputSchemas: {}, executorClass: "standard", ownershipRequest: [], budgetRequest: {},
      timeoutMs: 30_000, retryPolicy: { maxAttempts: 1, backoffMs: 0,
        retryableOutcomes: ["failed"], jitterMs: 0 }, verificationRequired: false,
      failurePolicy: "fail_graph", risk: "low", requiresApproval: false,
    }],
  };
}

function context(semanticPlan: SemanticTaskGraphPlan,
  connectedContext: string | null): PlanningSourceContext {
  return {
    workItemId: "work", primaryRunKey: "primary", revisionId: "revision",
    workspaceId: "workspace", cwd: "/repo", projectPath: "/repo",
    worktreeIdentity: "workspace:workspace", connectedContext,
    skillIds: [], skillValues: {}, harnessName: "codex", allowedTools: [],
    plan: semanticPlan, nodeIdsByStepKey: { build: "node-build" },
  };
}

describe("planning source capture", () => {
  beforeEach(() => { mocks.storedPacket = null; });

  it("freezes the same complete disclosure as the Leader, including eager bodies and attachment references", async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "graph-skill-"));
    try {
      const skill = { id: "design", name: "Design", description: "Design", category: "design" as const,
        icon: "*", accentColor: "#fff", template: "PARENT {{target}}", variables: [],
        attachments: [{ kind: "text" as const, filename: "guide.md", mediaType: "text/markdown", text: "PRIVATE_ATTACHMENT", truncated: false }],
        subskills: [
          { id: "layout", name: "Layout", description: "Layout rules", body: "LAZY_BODY" },
          { id: "core", name: "Core", description: "Always", body: "EAGER_BODY", alwaysInclude: true },
        ] };
      const values = { design: { target: "dashboard" } };
      const skillSnapshotId = saveSkillSnapshot(projectPath, { version: 1, skills: [skill], values });
      const input = { ...context(plan([]), null), projectPath, skillIds: ["design"], skillValues: values, skillSnapshotId };
      const captured = await capturePlanningSource(input, 1, async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));
      const delivered = captured.scopedSources.find(source => source.sourceId === "skill:design")!.content;
      expect(delivered).toBe(compileSkills([skill], values));
      for (const sentinel of ["PARENT dashboard", "EAGER_BODY", "load_subskill", "layout", "guide.md", "load_skill_attachment"]) expect(delivered).toContain(sentinel);
      expect(delivered).not.toContain("LAZY_BODY");
      expect(delivered).not.toContain("PRIVATE_ATTACHMENT");
      expect(captured.snapshot.skillSnapshotId).toBe(skillSnapshotId);
      const selectedPlan = { ...input.plan, steps: [
        { ...input.plan.steps[0]!, skillIds: ["design"] },
        { ...input.plan.steps[0]!, key: "plain", skillIds: [] },
      ] };
      const selected = await capturePlanningSource({ ...input, skillIds: [], plan: selectedPlan,
        nodeIdsByStepKey: { ...input.nodeIdsByStepKey, plain: "node-plain" } }, 2,
        async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));
      expect(selected.scopedSources.filter(source => source.sourceId === "skill:design"))
        .toHaveLength(1);
      expect(selected.scopedSources.some(source => source.nodeId === "node-plain")).toBe(false);
      await expect(capturePlanningSource({ ...input, plan: { ...input.plan,
        steps: [{ ...input.plan.steps[0]!, skillIds: ["missing"] }] } }, 3,
        async () => ({ baseCommit: "abc", dirtyDigest: HASH_A })))
        .rejects.toThrow(/(unavailable|not found|Unknown)/i);
    } finally { fs.rmSync(projectPath, { recursive: true, force: true }); }
  });

  it("routes only context groups selected by a node", async () => {
    const connected = `<connected-context>
      <context-group title="Authentication design">Auth rules</context-group>
      <context-group title="Billing notes">Authentication surcharge rules</context-group>
    </connected-context>`;

    const captured = await capturePlanningSource(context(plan(["canvas:authentication"]), connected), 1,
      async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));

    expect(captured.scopedSources).toHaveLength(1);
    expect(captured.scopedSources[0]?.content).toContain("Auth rules");
    expect(captured.scopedSources[0]?.content).not.toContain("Billing rules");
    expect(captured.snapshot.connectedContext).toHaveLength(2);
  });

  it("freezes titled and untitled canvas groups without dropping either", async () => {
    const connected = `<connected-context>
      <context-group>Default group content</context-group>
      <context-group title="Authentication design">Auth rules</context-group>
    </connected-context>`;

    const captured = await capturePlanningSource(
      context(plan(["canvas:connected context 1"]), connected), 1,
      async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));

    expect(captured.snapshot.connectedContext).toHaveLength(2);
    expect(captured.scopedSources).toHaveLength(1);
    expect(captured.scopedSources[0]?.content).toContain("Default group content");
  });

  it("fails explicitly instead of fanning out all context for an unmatched selector", async () => {
    const connected = `<context-group title="Billing notes">Billing rules</context-group>`;

    await expect(capturePlanningSource(
      context(plan(["canvas:authentication"]), connected), 1,
      async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }),
    )).rejects.toThrow("did not match frozen connected context");
  });

  it("does not mistake repository selectors for missing canvas context", async () => {
    const captured = await capturePlanningSource(context(plan(["repo:server/auth/**"]), null), 1,
      async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));

    expect(captured.scopedSources).toEqual([]);
  });

  it("includes frozen dirty repository state in the planning fingerprint", async () => {
    let dirtyDigest = HASH_A;
    const inspect = async () => ({ baseCommit: "abc", dirtyDigest });
    const first = await capturePlanningSource(context(plan([]), null), 1, inspect);
    dirtyDigest = HASH_B;
    const second = await capturePlanningSource(context(plan([]), null), 2, inspect);

    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.snapshot.dirtyDiffDigest).not.toBe(first.snapshot.dirtyDiffDigest);
  });

  it("carries pending merge reviews without blocking automatic execution", async () => {
    mocks.storedPacket = packet("required_pending", "partially_stale");
    const semanticPlan = { ...plan([]), workPacketId: "packet-1" };

    const captured = await capturePlanningSource(context(semanticPlan, null), 1,
      async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));

    expect(captured.startBlockedReason).toBeNull();
    expect(captured.policyAllowsAutoStart).toBe(true);
    expect(captured.reviewRequirements).toEqual([{
      gateId: "gate.execution", name: "Execution graph runtime", reason: "Matched packet scope",
    }]);
  });

  it("continues to block failed review gates", async () => {
    mocks.storedPacket = packet("failed", "fresh");
    const semanticPlan = { ...plan([]), workPacketId: "packet-1" };

    const captured = await capturePlanningSource(context(semanticPlan, null), 1,
      async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));

    expect(captured.startBlockedReason).toBe("Work Packet gate Execution graph runtime is failed.");
    expect(captured.reviewRequirements).toEqual([]);
  });
});

function packet(status: "required_pending" | "failed",
  freshness: "fresh" | "partially_stale" | "stale_blocked") {
  return { packet: { id: "packet-1", reviewGates: [{ gateId: "gate.execution",
    name: "Execution graph runtime", status, reason: "Matched packet scope" }],
  freshness: { status: freshness } }, contextPack: "Packet context" };
}
