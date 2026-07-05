/**
 * server/minion-tools — MCP tools the minion uses to report progress.
 *
 * Each handler is invoked directly via the `toolDefs` array the factory
 * returns; the test asserts on the captured `minion_status` envelope the bus
 * emits and on the NormalizedToolResult. We cover the four triggers (`step`,
 * `done`, `fail`, `blocked`) by parameterised cases — per
 * docs/testing-strategy.md §5.9, near-identical describe blocks would be a
 * duplicate.
 */
import { describe, it, expect } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus, type Bus } from "./bus.ts";
import { createMinionToolsForSession } from "./minion-tools.ts";
import type { NormalizedToolDef } from "./harness/types.ts";

interface CapturedEnvelope {
  topic?: string;
  type?: string;
  [key: string]: unknown;
}

function makeBus(): { bus: Bus; sent: CapturedEnvelope[] } {
  const sent: CapturedEnvelope[] = [];
  const client = {
    readyState: 1,
    send(msg: string) {
      sent.push(JSON.parse(msg) as CapturedEnvelope);
    },
  };
  const wss = {
    clients: new Set([client]),
  } as unknown as WebSocketServer;
  return { bus: createBus(wss), sent };
}

function findTool(
  toolDefs: ReadonlyArray<NormalizedToolDef>,
  name: string,
): NormalizedToolDef {
  const t = toolDefs.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

async function call(
  def: NormalizedToolDef,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[] }> {
  return (await def.handler(args)) as { content: { type: "text"; text: string }[] };
}

describe("minion-tools", () => {
  describe.each([
    {
      tool: "report_step",
      arg: { message: "Reading the source file" },
      trigger: "step",
      // For report_step the agent passes `message`; the bus event echoes it
      // back under the same key for the UI.
      expectedMessage: "Reading the source file",
    },
    {
      tool: "report_done",
      arg: { summary: "Task complete with two new tests" },
      trigger: "done",
      expectedMessage: "Task complete with two new tests",
    },
    {
      tool: "report_fail",
      arg: { reason: "Could not parse the input" },
      trigger: "fail",
      expectedMessage: "Could not parse the input",
    },
    {
      tool: "report_blocked",
      arg: { question: "Which migration strategy should I use?" },
      trigger: "blocked",
      expectedMessage: "Which migration strategy should I use?",
    },
  ])(
    "$tool",
    ({ tool: toolName, arg, trigger, expectedMessage }) => {
      it("emits a minion_status envelope on the minion's session topic", async () => {
        const { bus, sent } = makeBus();
        const { toolDefs } = createMinionToolsForSession({
          minionSessionKey: "minion-1",
          bus,
        });
        const def = findTool(toolDefs, toolName);
        const before = Date.now();

        await call(def, arg);

        // Exactly one envelope, on the right topic, with the right payload.
        expect(sent).toHaveLength(1);
        const env = sent[0]!;
        expect(env.topic).toBe("session:minion-1");
        expect(env.type).toBe("minion_status");
        expect(env["minionSessionKey"]).toBe("minion-1");
        expect(env["trigger"]).toBe(trigger);
        expect(env["message"]).toBe(expectedMessage);
        // Timestamp is recent (within the test's wallclock window).
        const ts = env["timestamp"] as number;
        expect(typeof ts).toBe("number");
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(Date.now());
      });

      it("returns a terse ack that does NOT echo the agent's payload", async () => {
        const { bus } = makeBus();
        const { toolDefs } = createMinionToolsForSession({
          minionSessionKey: "minion-2",
          bus,
        });
        const def = findTool(toolDefs, toolName);

        const result = await call(def, arg);

        expect(result.content).toHaveLength(1);
        expect(result.content[0]!.type).toBe("text");
        // Token-efficiency contract: the model already has its own input in
        // context, so the ack must be constant and must not repeat it.
        expect(result.content[0]!.text).toBe("ok");
        expect(result.content[0]!.text).not.toContain(expectedMessage);
      });
    },
  );

  describe.each([
    { tool: "report_step", badArg: { /* missing message */ } },
    { tool: "report_done", badArg: { /* missing summary */ } },
    { tool: "report_fail", badArg: { /* missing reason */ } },
    { tool: "report_blocked", badArg: { /* missing question */ } },
  ])("$tool parse guard", ({ tool: toolName, badArg }) => {
    it("rejects garbage input — missing required field throws before emitting", async () => {
      const { bus, sent } = makeBus();
      const { toolDefs } = createMinionToolsForSession({
        minionSessionKey: "parse-guard",
        bus,
      });
      const def = findTool(toolDefs, toolName);

      // Null is clearly invalid.
      await expect(def.handler(null)).rejects.toThrow();
      // Missing required field is also invalid.
      await expect(def.handler(badArg)).rejects.toThrow();
      // Nothing should have been emitted.
      expect(sent).toHaveLength(0);
    });
  });

  it("multiple report_step calls produce one envelope per call, preserving order", async () => {
    const { bus, sent } = makeBus();
    const { toolDefs } = createMinionToolsForSession({
      minionSessionKey: "m",
      bus,
    });
    const stepDef = findTool(toolDefs, "report_step");

    await call(stepDef, { message: "first" });
    await call(stepDef, { message: "second" });
    await call(stepDef, { message: "third" });

    expect(sent.map((e) => e["message"])).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("can mirror reports to the owning leader session with task metadata", async () => {
    const { bus, sent } = makeBus();
    const reports: Array<{ trigger: string; message: string }> = [];
    const { toolDefs } = createMinionToolsForSession({
      minionSessionKey: "minion-1",
      leaderSessionKey: "leader-1",
      taskId: "task-1",
      bus,
      onReport: (report) => reports.push(report),
    });
    const stepDef = findTool(toolDefs, "report_step");

    await call(stepDef, { message: "Running tests" });

    expect(sent).toHaveLength(2);
    expect(sent.map((e) => e.topic)).toEqual([
      "session:minion-1",
      "session:leader-1",
    ]);
    for (const env of sent) {
      expect(env.type).toBe("minion_status");
      expect(env["minionSessionKey"]).toBe("minion-1");
      expect(env["leaderSessionKey"]).toBe("leader-1");
      expect(env["taskId"]).toBe("task-1");
      expect(env["trigger"]).toBe("step");
      expect(env["message"]).toBe("Running tests");
    }
    expect(reports).toMatchObject([{ trigger: "step", message: "Running tests" }]);
  });

  it("describes summary-first artifact-file reporting for terminal/blocking reports", () => {
    const { bus } = makeBus();
    const { toolDefs } = createMinionToolsForSession({
      minionSessionKey: "m",
      bus,
    });

    for (const name of ["report_done", "report_fail", "report_blocked"]) {
      const def = findTool(toolDefs, name);
      expect(def.description).toContain("summary-first");
      expect(def.description).toContain("artifact file");
    }
  });
});
