/**
 * set_task_name — emits a session_task_name envelope on the leader's topic.
 */
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import { createSetTaskNameToolDef } from "./set-task-name.ts";
import type { TaskToolContext } from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

function makeCtx(): TaskToolContext & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const client = {
    readyState: 1,
    send(msg: string) {
      sent.push(JSON.parse(msg) as Record<string, unknown>);
    },
  };
  const wss = { clients: new Set([client]) } as unknown as WebSocketServer;
  return {
    leaderSessionKey: "leader-1",
    bus: createBus(wss),
    startMinionSession: () => {},
    cwd: "/p",
    projectPath: "/p",
    minionSystemPrompt: "",
    taskState: { tasks: new Map(), pendingWait: null, approval: null },
    scheduleWaitContinue: () => {},
    sent,
  };
}

async function call(
  def: NormalizedToolDef,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[] }> {
  return (await def.handler(args)) as { content: { type: "text"; text: string }[] };
}

describe("set_task_name", () => {
  it("rejects garbage input before emitting — parse guard", async () => {
    const ctx = makeCtx();
    const tool = createSetTaskNameToolDef(ctx);

    // Null and missing 'name' are both invalid.
    await expect(call(tool, null)).rejects.toThrow();
    await expect(call(tool, {})).rejects.toThrow();
    // 'name' must be a string — a number is invalid.
    await expect(call(tool, { name: 42 })).rejects.toThrow();
    // Nothing should have been emitted.
    expect(ctx.sent).toHaveLength(0);
  });

  it("emits session_task_name on the leader's session topic with the supplied name", async () => {
    const ctx = makeCtx();
    const tool = createSetTaskNameToolDef(ctx);
    await call(tool, { name: "Audit Performative Tests" });

    expect(ctx.sent).toHaveLength(1);
    const env = ctx.sent[0]!;
    expect(env["topic"]).toBe("session:leader-1");
    expect(env["type"]).toBe("session_task_name");
    expect(env["sessionKey"]).toBe("leader-1");
    expect(env["taskName"]).toBe("Audit Performative Tests");
  });

  it("forwards the name verbatim including punctuation and unicode", async () => {
    const ctx = makeCtx();
    const tool = createSetTaskNameToolDef(ctx);
    const name = "Phase 5 — split index.ts (✂)";
    await call(tool, { name });
    expect(ctx.sent[0]!["taskName"]).toBe(name);
  });
});
