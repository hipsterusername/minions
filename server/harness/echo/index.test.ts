/**
 * Unit tests for EchoHarness.
 *
 * Verifies the full AgentHarness contract:
 *   - name / capabilities / builtInTools are correct
 *   - start() emits init → text → done with the prompt text
 *   - abort via AbortSignal stops before the text event
 *   - abort via control.abort() stops before the text event
 *   - resolveModel returns the alias unchanged (any non-empty string)
 *   - resolveModel returns null for empty / falsy input
 *   - registerTools stores defs without throwing
 *   - self-registration: the singleton is in the harness registry
 */

import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../../../shared/normalized-event.ts";
import type { NormalizedToolDef } from "../types.ts";
import { registeredHarnessNames } from "../index.ts";

// Side-effect import triggers self-registration.
import { echoHarness } from "./index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect all events from the harness into an array. */
async function collect(
  opts: Partial<Parameters<typeof echoHarness.start>[0]> & { prompt: string },
): Promise<NormalizedEvent[]> {
  const controller = new AbortController();
  const events: NormalizedEvent[] = [];
  for await (const ev of echoHarness.start({
    cwd: "/tmp",
    systemPrompt: "sys",
    model: "echo",
    allowedTools: [],
    abortSignal: controller.signal,
    sessionKey: "test-session",
    ...opts,
  }).events) {
    events.push(ev);
  }
  return events;
}

// ── Static properties ─────────────────────────────────────────────────────────

describe("EchoHarness static properties", () => {
  it("name is 'echo'", () => {
    expect(echoHarness.name).toBe("echo");
  });

  it("builtInTools is empty", () => {
    expect(echoHarness.builtInTools).toEqual([]);
  });

  it("all capabilities are false", () => {
    const caps = echoHarness.capabilities;
    expect(caps.mutationInterception).toBe("none");
    expect(caps.thinking).toBe(false);
    expect(caps.promptCaching).toBe(false);
    expect(caps.mcp).toBe(false);
    expect(caps.permissionPrompts).toBe(false);
    expect(caps.resume).toBe(false);
    expect(caps.partialMessages).toBe(false);
    expect(caps.builtInFilesystem).toBe(false);
  });
});

// ── Self-registration ─────────────────────────────────────────────────────────

describe("self-registration", () => {
  it("registers itself in the harness registry on import", () => {
    expect(registeredHarnessNames()).toContain("echo");
  });
});

// ── resolveModel ─────────────────────────────────────────────────────────────

describe("resolveModel", () => {
  it("returns the alias unchanged for any non-empty string", () => {
    expect(echoHarness.resolveModel("my-model")).toBe("my-model");
    expect(echoHarness.resolveModel("gpt-99")).toBe("gpt-99");
    expect(echoHarness.resolveModel("sonnet")).toBe("sonnet");
  });

  it("returns null for an empty string", () => {
    expect(echoHarness.resolveModel("")).toBeNull();
  });
});

// ── registerTools ─────────────────────────────────────────────────────────────

describe("registerTools", () => {
  it("stores defs without throwing when given a keyed group map", () => {
    const def: NormalizedToolDef = {
      name: "noop",
      description: "does nothing",
      inputSchema: {} as NormalizedToolDef["inputSchema"],
      handler: async () => ({ content: [{ type: "text" as const, text: "" }] }),
    };
    // registerTools takes Record<string, NormalizedToolDef[]> — keys are
    // MCP server names, values are the tool defs for that server.
    expect(() => echoHarness.registerTools({ "my-server": [def] })).not.toThrow();
    expect(() => echoHarness.registerTools({})).not.toThrow();
  });
});

// ── staticInfo ────────────────────────────────────────────────────────────────

describe("staticInfo", () => {
  it("returns provider 'echo'", () => {
    expect(echoHarness.staticInfo().account.provider).toBe("echo");
  });

  it("returns at least one model entry", () => {
    expect(echoHarness.staticInfo().models.length).toBeGreaterThan(0);
  });
});

// ── start(): event contract ──────────────────────────────────────────────────

describe("start() — event sequence", () => {
  it("first event is 'init'", async () => {
    const events = await collect({ prompt: "hello" });
    expect(events[0]?.kind).toBe("init");
  });

  it("last event is 'done' with reason 'stop'", async () => {
    const events = await collect({ prompt: "hello" });
    const last = events.at(-1);
    expect(last?.kind).toBe("done");
    if (last?.kind === "done") {
      expect(last.reason).toBe("stop");
    }
  });

  it("emits exactly 3 events: init → text → done", async () => {
    const events = await collect({ prompt: "ping" });
    expect(events.map((e) => e.kind)).toEqual(["init", "text", "done"]);
  });

  it("text event content equals the prompt (the echo)", async () => {
    const events = await collect({ prompt: "echo this back please" });
    const textEv = events.find((e) => e.kind === "text");
    expect(textEv?.kind).toBe("text");
    if (textEv?.kind === "text") {
      expect(textEv.text).toBe("echo this back please");
    }
  });

  it("init event carries the sessionId and model", async () => {
    const events = await collect({ prompt: "x", model: "my-model" });
    const initEv = events[0];
    expect(initEv?.kind).toBe("init");
    if (initEv?.kind === "init") {
      expect(typeof initEv.sessionId).toBe("string");
      expect(initEv.sessionId.length).toBeGreaterThan(0);
      expect(initEv.model).toBe("my-model");
    }
  });

  it("falls back to 'echo' as model when no model is supplied", async () => {
    const events = await collect({ prompt: "x", model: "" });
    const initEv = events[0];
    if (initEv?.kind === "init") {
      expect(initEv.model).toBe("echo");
    }
  });

  it("echos an async-iterable prompt by joining parts with newlines", async () => {
    async function* parts() {
      yield { role: "user" as const, content: "line one" };
      yield { role: "user" as const, content: "line two" };
    }
    const controller = new AbortController();
    const events: NormalizedEvent[] = [];
    for await (const ev of echoHarness.start({
      cwd: "/tmp",
      systemPrompt: "sys",
      model: "echo",
      allowedTools: [],
      abortSignal: controller.signal,
      sessionKey: "test-session",
      prompt: parts(),
    }).events) {
      events.push(ev);
    }
    const textEv = events.find((e) => e.kind === "text");
    if (textEv?.kind === "text") {
      expect(textEv.text).toBe("line one\nline two");
    } else {
      throw new Error("expected a text event");
    }
  });
});

// ── start(): abort behaviour ──────────────────────────────────────────────────

describe("start() — abort via AbortSignal", () => {
  it("emits done(abort) when the signal is already aborted on entry", async () => {
    const controller = new AbortController();
    controller.abort();

    const events: NormalizedEvent[] = [];
    for await (const ev of echoHarness.start({
      cwd: "/tmp",
      systemPrompt: "",
      model: "echo",
      allowedTools: [],
      abortSignal: controller.signal,
      sessionKey: "test-session",
      prompt: "should not echo",
    }).events) {
      events.push(ev);
    }

    // init is yielded before the first abort check; done(abort) follows.
    expect(events.map((e) => e.kind)).toEqual(["init", "done"]);
    const doneEv = events.at(-1);
    if (doneEv?.kind === "done") {
      expect(doneEv.reason).toBe("abort");
    }
  });
});

describe("start() — abort via AbortSignal mid-stream", () => {
  it("emits done(abort) when AbortSignal is triggered between init and text", async () => {
    const controller = new AbortController();
    const events: NormalizedEvent[] = [];

    // We need to interleave abort between the init yield and the text yield.
    // Strategy: consume events one by one, abort after receiving init.
    const iter = echoHarness.start({
      cwd: "/tmp",
      systemPrompt: "",
      model: "echo",
      allowedTools: [],
      abortSignal: controller.signal,
      sessionKey: "test-session",
      prompt: "should not appear",
    }).events;

    for await (const ev of iter) {
      events.push(ev);
      if (ev.kind === "init") {
        controller.abort();
      }
    }

    expect(events.map((e) => e.kind)).toEqual(["init", "done"]);
    const doneEv = events.at(-1);
    if (doneEv?.kind === "done") {
      expect(doneEv.reason).toBe("abort");
    }
  });
});
