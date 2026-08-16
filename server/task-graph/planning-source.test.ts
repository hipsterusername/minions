import "./test-helpers.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticTaskGraphPlan } from "../../shared/task-graph-planning-contracts.ts";

vi.mock("../skills.ts", () => ({
  loadSkillsByIds: () => [],
  compileSkillTemplate: () => "",
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

  it("defers pending merge reviews without blocking manual start", async () => {
    mocks.storedPacket = packet("required_pending", "partially_stale");
    const semanticPlan = { ...plan([]), workPacketId: "packet-1" };

    const captured = await capturePlanningSource(context(semanticPlan, null), 1,
      async () => ({ baseCommit: "abc", dirtyDigest: HASH_A }));

    expect(captured.startBlockedReason).toBeNull();
    expect(captured.policyAllowsAutoStart).toBe(false);
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

function packet(status: "required_pending" | "failed", freshness: string) {
  return { packet: { id: "packet-1", reviewGates: [{ gateId: "gate.execution",
    name: "Execution graph runtime", status, reason: "Matched packet scope" }],
  freshness: { status } }, contextPack: "Packet context" };
}
