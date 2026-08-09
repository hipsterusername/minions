import { describe, it, expect } from "vitest";
import "./dialectic-planner.ts";
import { getAgentType } from "./registry.ts";
import type { AgentTypeContext } from "./types.ts";
import { awaitTurn, cancelTurn } from "../dialectic/turn-bridge.ts";

function ctxFor(sessionKey: string): AgentTypeContext {
  // Only sessionKey is read by the dialectic-planner onComplete.
  return { sessionKey } as unknown as AgentTypeContext;
}

describe("dialectic-planner agent onComplete", () => {
  it("forwards the underlying error text on a failed turn", async () => {
    const key = "dialectic-test-A";
    const pending = awaitTurn(key);
    getAgentType("dialectic-planner").onComplete?.(ctxFor(key), {
      is_error: true,
      result: null,
      error: "model claude-sonnet-5 is not available",
    });
    const turn = await pending;
    expect(turn.isError).toBe(true);
    expect(turn.error).toBe("model claude-sonnet-5 is not available");
  });

  it("forwards the assistant text and no error on a successful turn", async () => {
    const key = "dialectic-test-ok";
    const pending = awaitTurn(key);
    getAgentType("dialectic-planner").onComplete?.(ctxFor(key), {
      is_error: false,
      result: "here is my plan",
      error: null,
    });
    const turn = await pending;
    expect(turn).toEqual({ text: "here is my plan", isError: false, error: undefined });
  });

  it("ignores blank error strings", async () => {
    const key = "dialectic-test-blank";
    const pending = awaitTurn(key);
    getAgentType("dialectic-planner").onComplete?.(ctxFor(key), {
      is_error: true,
      result: null,
      error: "   ",
    });
    const turn = await pending;
    expect(turn.isError).toBe(true);
    expect(turn.error).toBeUndefined();
  });
});

describe("dialectic-planner buildSystemPrompt", () => {
  it("returns the custom prompt when provided", () => {
    const customPrompt = "You are the affirmative side of the debate.";

    expect(
      getAgentType("dialectic-planner").buildSystemPrompt(ctxFor("dialectic-prompt"), customPrompt),
    ).toBe(customPrompt);
  });

  it.each([undefined, "", "   "])("throws when customPrompt is absent or empty", (customPrompt) => {
    expect(() =>
      getAgentType("dialectic-planner").buildSystemPrompt(
        ctxFor("dialectic-missing-prompt"),
        customPrompt,
      ),
    ).toThrow(
      "dialectic-planner requires a customPrompt from the dialectic orchestrator",
    );
  });
});

describe("turn-bridge cancelTurn", () => {
  it("resolves a pending waiter with an explanatory error sentinel", async () => {
    const key = "dialectic-test-cancel";
    const pending = awaitTurn(key);
    cancelTurn(key);
    const turn = await pending;
    expect(turn).toEqual({ text: "", isError: true, error: "Turn cancelled" });
  });
});
