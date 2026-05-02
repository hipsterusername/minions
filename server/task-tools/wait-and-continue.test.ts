/**
 * wait_and_continue — records a pending wait, broadcasts wait_state, and
 * delegates the actual timer to the server-supplied scheduleWaitContinue.
 */
import { describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { createWaitAndContinueToolDef } from "./wait-and-continue.ts";
import type { TaskToolContext } from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

function makeCtx() {
  const sent: Record<string, unknown>[] = [];
  const client = {
    readyState: 1,
    send(msg: string) {
      sent.push(JSON.parse(msg) as Record<string, unknown>);
    },
  };
  const wss = { clients: new Set([client]) } as unknown as WebSocketServer;
  const scheduleWaitContinue = vi.fn();
  const ctx: TaskToolContext & {
    sent: Record<string, unknown>[];
    scheduleWaitContinue: typeof scheduleWaitContinue;
  } = {
    leaderSessionKey: "leader-1",
    bus: createBus(wss),
    startMinionSession: () => {},
    cwd: "/p",
    projectPath: "/p",
    minionSystemPrompt: "",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue,
    sent,
  };
  return ctx;
}

async function call(
  def: NormalizedToolDef,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[] }> {
  return (await def.handler(args)) as { content: { type: "text"; text: string }[] };
}

describe("wait_and_continue", () => {
  it("records the pendingWait on task state, broadcasts wait_state, and calls scheduleWaitContinue", async () => {
    const ctx = makeCtx();
    const tool = createWaitAndContinueToolDef(ctx);

    await call(tool, { duration_seconds: 30, reason: "waiting on minion" });

    expect(ctx.taskState.pendingWait).toMatchObject({
      durationMs: 30_000,
      reason: "waiting on minion",
      timerId: null,
    });
    expect(typeof ctx.taskState.pendingWait!.scheduledAt).toBe("number");

    expect(ctx.sent).toHaveLength(1);
    const env = ctx.sent[0]!;
    expect(env["topic"]).toBe("session:leader-1");
    expect(env["type"]).toBe("wait_state");
    expect(env["action"]).toBe("started");
    expect(env["durationMs"]).toBe(30_000);
    expect(env["reason"]).toBe("waiting on minion");

    expect(ctx.scheduleWaitContinue).toHaveBeenCalledTimes(1);
    expect(ctx.scheduleWaitContinue).toHaveBeenCalledWith(
      30_000,
      "waiting on minion",
    );
  });

  it("formats the user-facing duration text for sub-minute and multi-minute waits", async () => {
    const ctx1 = makeCtx();
    const out1 = await call(createWaitAndContinueToolDef(ctx1), {
      duration_seconds: 45,
      reason: "x",
    });
    // Sub-minute wait is rendered as "<n>s" — verify presence of "45s"
    // without pinning the surrounding sentence.
    expect(out1.content[0]!.text).toContain("45s");

    const ctx2 = makeCtx();
    const out2 = await call(createWaitAndContinueToolDef(ctx2), {
      duration_seconds: 125,
      reason: "x",
    });
    // 125s = 2m 5s
    expect(out2.content[0]!.text).toContain("2m");
    expect(out2.content[0]!.text).toContain("5s");

    const ctx3 = makeCtx();
    const out3 = await call(createWaitAndContinueToolDef(ctx3), {
      duration_seconds: 120,
      reason: "x",
    });
    // 120s = 2m flat — should NOT include "0s"
    expect(out3.content[0]!.text).toContain("2m");
    expect(out3.content[0]!.text).not.toMatch(/\b0s\b/);
  });
});
