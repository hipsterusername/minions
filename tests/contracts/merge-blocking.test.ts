import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetailedDiff, MergeResult, WorktreeInfo } from "../../server/worktree-types.ts";
import { cmd, setup } from "../../server/commands/test-harness.ts";
import { copyValidFixture } from "../../server/system-model/load.test.ts";
import { writeSettings } from "../../server/project-store.ts";
import { saveWorkPacket } from "../../server/system-model/store.ts";
import type { CommandHandler } from "../../server/commands/types.ts";
import type { WorkPacket } from "../../shared/system-model/index.ts";

const mergeCalls: Array<{ options?: { force?: boolean; strategy?: "ours" | "theirs"; rebase?: boolean } }> = [];

vi.mock("../../server/worktree.ts", () => ({
  getDetailedDiff: vi.fn(async (): Promise<DetailedDiff> => ({
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    files: [{ file: "server/commands/helpers.ts", insertions: 1, deletions: 0, status: "modified" }],
    commits: [],
    branch: "canvas/k",
  })),
  mergeAndCleanup: vi.fn(async (_info, _target, options): Promise<MergeResult> => {
    mergeCalls.push({ options });
    return { success: true, conflicts: [], summary: "merged", targetBranch: "main" };
  }),
}));

import { dispatchCommand } from "../../server/commands/index.ts";

beforeEach(() => {
  mergeCalls.length = 0;
});

describe("contract: enforced merge blocking", () => {
  it.each([
    ["approve_changes", undefined],
    ["force_merge", { force: true }],
    ["theirs_merge", { strategy: "theirs" as const }],
    ["retry_merge", undefined],
  ])("refuses %s through runMergeFlow when gates are not allowed", async (type, _options) => {
    const h = enforcedHarness();

    dispatchCommand(h.ctx, cmd({ type: type as never }), h.ws);
    await flush();

    expect(mergeCalls).toHaveLength(0);
    expect(h.wsSent.find((event) => event.type === "control_response")).toMatchObject({
      success: false,
      error: "Merge blocked by system-model gate",
      verdict: expect.objectContaining({ mode: "enforced", allowed: false }),
    });
    expect(h.busSent.find((event) => event.type === "merge_blocked_by_gate")).toMatchObject({
      verdict: expect.objectContaining({ allowed: false }),
    });
  });

  it("refuses merge_worktree when gates are not allowed", async () => {
    const h = enforcedHarness();

    dispatchCommand(h.ctx, cmd({ type: "merge_worktree" }), h.ws);
    await flush();

    expect(mergeCalls).toHaveLength(0);
    expect(h.wsSent.find((event) => event.type === "control_response")).toMatchObject({
      success: false,
      verdict: expect.objectContaining({ mode: "enforced", allowed: false }),
    });
    expect(h.busSent.some((event) => event.type === "merge_blocked_by_gate")).toBe(true);
  });

  it("waives a blocked gate and allows the next merge", async () => {
    const h = enforcedHarness();
    saveWorkPacket(h.project, packet, "context", 2);

    dispatchCommand(h.ctx, cmd({ type: "approve_changes" }), h.ws);
    await flush();
    expect(mergeCalls).toHaveLength(0);

    dispatchCommand(
      h.ctx,
      cmd({ type: "waive_review_gate", gateId: "gate.review", reason: "human accepted risk" }),
      h.ws,
    );
    dispatchCommand(h.ctx, cmd({ type: "approve_changes" }), h.ws);
    await flush();

    expect(mergeCalls).toHaveLength(1);
    expect(h.host.worktree).toBeNull();
    expect(h.busSent.some((event) => event.type === "worktree_merged")).toBe(true);
  });
});

function enforcedHarness(): ReturnType<typeof setup> & { project: string } {
  const project = copyValidFixture();
  writeSettings(project, { systemModel: "enforced" });
  const h = setup({ cwd: project, status: "running" });
  h.host.worktree = worktree(project);
  return Object.assign(h, { project });
}

function worktree(project: string): WorktreeInfo {
  return {
    path: project,
    branch: "canvas/k",
    leaderSessionKey: "leader-1",
    createdAt: 1,
    projectPath: project,
    lifecycle: "active",
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const packet: WorkPacket = {
  id: "wp_merge",
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
