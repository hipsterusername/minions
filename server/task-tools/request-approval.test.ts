/**
 * request_approval — gathers the worktree diff, records approval state, and
 * broadcasts approval_requested. The diff comes from `getDetailedDiff` —
 * we mock that single boundary so the test stays focused on the tool's
 * contract (NOT the diff parser, which has its own coverage in
 * worktree-diff.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import type { DetailedDiff, WorktreeInfo } from "../worktree-types.ts";
import type { TaskToolContext } from "./types.ts";

const fakeDiff: DetailedDiff = {
  filesChanged: 2,
  insertions: 7,
  deletions: 3,
  files: [
    { file: "a.ts", insertions: 5, deletions: 1, status: "modified" },
    { file: "b.ts", insertions: 2, deletions: 2, status: "added" },
  ],
  commits: ["abc1234 first commit"],
  branch: "canvas/k",
};

let diffShouldThrow = false;
const diffMock = vi.fn(async (): Promise<DetailedDiff> => {
  if (diffShouldThrow) throw new Error("git failed");
  return fakeDiff;
});

vi.mock("../worktree.js", () => ({
  getDetailedDiff: (info: WorktreeInfo) => diffMock(info),
}));

import { createRequestApprovalTool } from "./request-approval.ts";

beforeEach(() => {
  diffShouldThrow = false;
  diffMock.mockClear();
});

afterEach(() => {
  diffShouldThrow = false;
});

function makeCtx(opts?: { worktreeInfo?: WorktreeInfo | null }) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    readyState: 1,
    send(msg: string) {
      sent.push(JSON.parse(msg) as Record<string, unknown>);
    },
  };
  const wss = { clients: new Set([client]) } as unknown as WebSocketServer;
  // `??` would fall through `null`, but the test passes `null` deliberately
  // to exercise the no-worktree branch. Use the property check instead.
  const worktreeInfo: WorktreeInfo | null =
    opts && "worktreeInfo" in opts
      ? (opts.worktreeInfo ?? null)
      : {
          path: "/p/.canvas-worktrees/k",
          branch: "canvas/k",
          leaderSessionKey: "k",
          createdAt: 0,
          projectPath: "/p",
          lifecycle: "active",
        };
  const ctx: TaskToolContext & { sent: Record<string, unknown>[] } = {
    leaderSessionKey: "leader-1",
    bus: createBus(wss),
    startMinionSession: () => {},
    cwd: "/p",
    projectPath: "/p",
    minionSystemPrompt: "",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue: () => {},
    sent,
    worktreeInfo,
  };
  return ctx;
}

async function call(
  tool: ReturnType<typeof createRequestApprovalTool>,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[] }> {
  return (await (
    tool as unknown as {
      handler: (a: unknown, e: unknown) => Promise<{
        content: { type: "text"; text: string }[];
      }>;
    }
  ).handler(args, undefined));
}

describe("request_approval", () => {
  it("records approval state, fetches the diff, and broadcasts approval_requested", async () => {
    const ctx = makeCtx();
    const tool = createRequestApprovalTool(ctx);

    await call(tool, { summary: "Refactored the parser" });

    expect(diffMock).toHaveBeenCalledTimes(1);
    expect(ctx.taskState.approval).toMatchObject({
      requested: true,
      summary: "Refactored the parser",
      diff: fakeDiff,
    });
    expect(typeof ctx.taskState.approval!.requestedAt).toBe("number");

    expect(ctx.sent).toHaveLength(1);
    const env = ctx.sent[0]!;
    expect(env["type"]).toBe("approval_requested");
    expect(env["sessionKey"]).toBe("leader-1");
    expect(env["summary"]).toBe("Refactored the parser");
    expect(env["diff"]).toEqual(fakeDiff);
  });

  it("returns the early no-worktree message and does NOT touch state when worktreeInfo is null", async () => {
    const ctx = makeCtx({ worktreeInfo: null });
    const tool = createRequestApprovalTool(ctx);

    const out = await call(tool, { summary: "x" });

    expect(diffMock).not.toHaveBeenCalled();
    expect(ctx.taskState.approval).toBeNull();
    expect(ctx.sent).toEqual([]);
    expect(out.content[0]!.text.toLowerCase()).toContain("worktree");
  });

  it("surfaces a typed error message when getDetailedDiff throws", async () => {
    diffShouldThrow = true;
    const ctx = makeCtx();
    const tool = createRequestApprovalTool(ctx);

    const out = await call(tool, { summary: "x" });

    // Approval state remains null on diff failure.
    expect(ctx.taskState.approval).toBeNull();
    expect(ctx.sent).toEqual([]);
    expect(out.content[0]!.text.toLowerCase()).toContain("git failed");
  });

  it("the response text references the per-file change summary the agent will need", async () => {
    const ctx = makeCtx();
    const tool = createRequestApprovalTool(ctx);

    const out = await call(tool, { summary: "Refactored the parser" });

    // The response carries the file table the agent uses to render the
    // dashboard. Check for the file names + line counts (not literal
    // copy / instructions text).
    expect(out.content[0]!.text).toContain("a.ts");
    expect(out.content[0]!.text).toContain("b.ts");
    expect(out.content[0]!.text).toContain("+5");
    expect(out.content[0]!.text).toContain("-1");
  });
});
