/**
 * Contract: the dialectic WS commands are validated and dispatchable.
 *
 * Crosses the boundary between the schema gate (`commands/schemas.ts`) and the
 * command table (`commands/index.ts`). If either drifts — a schema is removed,
 * a handler goes missing, or the coordinator event shape changes — this fails.
 */

import { describe, it, expect } from "vitest";
import { validateWsCommand } from "../../server/commands/schemas.ts";
import { COMMAND_TABLE } from "../../server/commands/index.ts";
import {
  DIALECTIC_EVENT_TYPE,
  normalizeDialecticConfig,
} from "../../shared/dialectic.ts";

describe("contract: dialectic commands", () => {
  it("accepts a well-formed start_dialectic command", () => {
    const result = validateWsCommand({
      type: "start_dialectic",
      sessionKey: "node-123",
      cwd: "/repo",
      prompt: "Design the caching layer",
      dialecticConfig: {
        mode: "proposer-critic",
        rounds: 3,
        plannerA: { harness: "claude", model: "claude-opus-4-8" },
        plannerB: { harness: "claude", model: "claude-sonnet-5" },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts start_dialectic without a config (handler fills defaults)", () => {
    const result = validateWsCommand({
      type: "start_dialectic",
      sessionKey: "node-1",
      prompt: "topic",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects start_dialectic with a mistyped field", () => {
    const result = validateWsCommand({
      type: "start_dialectic",
      sessionKey: "node-1",
      prompt: 42, // must be a string
    });
    expect(result.ok).toBe(false);
  });

  it("accepts stop_dialectic", () => {
    const result = validateWsCommand({ type: "stop_dialectic", sessionKey: "node-1" });
    expect(result.ok).toBe(true);
  });

  it("registers handlers for both dialectic commands", () => {
    expect(typeof COMMAND_TABLE.start_dialectic).toBe("function");
    expect(typeof COMMAND_TABLE.stop_dialectic).toBe("function");
  });

  it("normalizes an unknown config payload into a valid config", () => {
    const cfg = normalizeDialecticConfig({ mode: "bogus", rounds: 999 });
    expect(cfg.mode).toBe("ping-pong");
    expect(cfg.rounds).toBe(8);
    expect(DIALECTIC_EVENT_TYPE).toBe("dialectic_update");
  });
});
