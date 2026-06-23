/**
 * Tests for the submit_form command handler.
 *
 * Strategy: supply a fake CommandContext (mock registry.get and registry.start)
 * and a fake WebSocket (capture send calls), then assert:
 *   1. The correct synthetic prompt is passed to registry.start.
 *   2. Error paths unicast the right message without calling start.
 */

import { describe, expect, it, vi } from "vitest";
import { submitForm } from "./submit-form.ts";
import type { CommandContext, WsCommand } from "./types.ts";
import type { Bus } from "../bus.ts";

// ── Test utilities ─────────────────────────────────────────

interface SentMessage {
  payload: Record<string, unknown>;
}

function makeFakeWs(): {
  ws: { send: (s: string) => void; readyState: 1 };
  sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  return {
    sent,
    ws: {
      readyState: 1,
      send: (raw: string) =>
        sent.push({ payload: JSON.parse(raw) as Record<string, unknown> }),
    },
  };
}

function makeBus(): Bus {
  return {
    emit: () => {},
    emitToSession: () => {},
    emitToProject: () => {},
    emitGlobal: () => {},
    subscribe: () => () => {},
  };
}

interface FakeHost {
  cwd: string;
  sessionId: string | null;
  role: "leader" | "minion";
  thinkingConfig: null;
}

function makeCtx(host: FakeHost | null): {
  ctx: CommandContext;
  startMock: ReturnType<typeof vi.fn>;
} {
  const startMock = vi.fn();
  const ctx: CommandContext = {
    registry: {
      get: (_key: string) => host as unknown as ReturnType<CommandContext["registry"]["get"]>,
      start: startMock,
    } as unknown as CommandContext["registry"],
    bus: makeBus(),
    generateKey: () => "key",
    maxSessions: 10,
    routines: {} as unknown as CommandContext["routines"],
  };
  return { ctx, startMock };
}

function baseCmd(
  overrides: Partial<WsCommand & { formComponentId?: string; formAnswers?: Record<string, unknown> }>,
): WsCommand & { formComponentId?: string; formAnswers?: Record<string, unknown> } {
  return {
    type: "send_message",
    sessionKey: "sess-1",
    formComponentId: "form-abc",
    formAnswers: { env: "prod", canary: 25 },
    ...overrides,
  };
}

const DEFAULT_HOST: FakeHost = {
  cwd: "/projects/foo",
  sessionId: "sdk-session-id",
  role: "leader",
  thinkingConfig: null,
};

// ── Happy-path tests ───────────────────────────────────────

describe("submitForm — success path", () => {
  it("calls registry.start with the synthetic form prompt", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    expect(startMock).toHaveBeenCalledOnce();

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["sessionKey"]).toBe("sess-1");
    expect(opts["prompt"]).toContain("[The user submitted form 'form-abc'");
    // Compact JSON (no pretty-print spacing) — the prompt is paid for in
    // model tokens on every subsequent turn.
    expect(opts["prompt"]).toContain('"env":"prod"');
    expect(opts["prompt"]).toContain('"canary":25');
    expect(opts["cwd"]).toBe("/projects/foo");
  });

  it("passes resumeId from host.sessionId", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["resumeId"]).toBe("sdk-session-id");
  });

  it("passes undefined resumeId when sessionId is null", () => {
    const host: FakeHost = { ...DEFAULT_HOST, sessionId: null };
    const { ctx, startMock } = makeCtx(host);
    const { ws } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["resumeId"]).toBeUndefined();
  });

  it("forwards the host role to registry.start", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["role"]).toBe("leader");
  });

  it("sends no error messages on the happy path", () => {
    const { ctx } = makeCtx(DEFAULT_HOST);
    const { ws, sent } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    const errorMessages = sent.filter(
      (m) => m.payload["type"] === "error",
    );
    expect(errorMessages).toHaveLength(0);
  });

  it("includes all answers in the JSON body of the prompt", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();
    const answers = { a: 1, b: "two", c: true, d: ["x", "y"] };

    submitForm(ctx, baseCmd({ formAnswers: answers }), ws as unknown as Parameters<typeof submitForm>[2]);

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const prompt = String(opts["prompt"]);
    const parsed = JSON.parse(prompt.replace(/.*\n\n/s, "")) as unknown;
    expect(parsed).toEqual(answers);
  });
});

// ── Error-path tests ───────────────────────────────────────

describe("submitForm — validation errors", () => {
  it("sends global error and does not call start when sessionKey is missing", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws, sent } = makeFakeWs();

    submitForm(
      ctx,
      baseCmd({ sessionKey: undefined }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    expect(startMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload["topic"]).toBe("global");
    expect(sent[0]?.payload["type"]).toBe("error");
  });

  it("sends session error when formComponentId is missing", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws, sent } = makeFakeWs();

    submitForm(
      ctx,
      baseCmd({ formComponentId: undefined }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    expect(startMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload["type"]).toBe("error");
    expect(String(sent[0]?.payload["message"])).toMatch(/formComponentId/);
  });

  it("sends session error when formAnswers is missing", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws, sent } = makeFakeWs();

    submitForm(
      ctx,
      baseCmd({ formAnswers: undefined }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    expect(startMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.payload["message"])).toMatch(/formAnswers/);
  });

  it("sends session error when session is not found in registry", () => {
    const { ctx, startMock } = makeCtx(null); // null → registry.get returns null
    const { ws, sent } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    expect(startMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.payload["message"])).toMatch(/not found/);
  });

  it("sends session error when formAnswers is an array instead of an object", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws, sent } = makeFakeWs();

    submitForm(
      ctx,
      // Force invalid shape via cast
      baseCmd({ formAnswers: ["a", "b"] as unknown as Record<string, unknown> }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    expect(startMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.payload["message"])).toMatch(/formAnswers/);
  });
});

// ── Prompt format invariant ────────────────────────────────

describe("submitForm — prompt format", () => {
  it("prompt starts with the expected sentinel prefix", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();

    submitForm(
      ctx,
      baseCmd({ formComponentId: "my-form", formAnswers: { x: 1 } }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const prompt = String(opts["prompt"]);
    expect(prompt).toMatch(
      /^\[The user submitted form 'my-form' with the following answers:\]/,
    );
  });

  it("prompt body is valid JSON that round-trips answers", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();
    const answers = { field1: "hello", field2: 99, field3: ["a"] };

    submitForm(
      ctx,
      baseCmd({ formAnswers: answers }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const prompt = String(opts["prompt"]);
    // Extract JSON part (everything after the first blank line)
    const jsonPart = prompt.split("\n\n").slice(1).join("\n\n");
    const parsed = JSON.parse(jsonPart) as unknown;
    expect(parsed).toEqual(answers);
  });
});
