
import { describe, expect, it, vi } from "vitest";
import { submitForm } from "./submit-form.ts";
import type { CommandContext, WsCommand } from "./types.ts";
import type { Bus } from "../bus.ts";
import { validateCheckpointBoundary } from "../task-tools/checkpoint-session.ts";
import {
  findFormById,
  findUnansweredForms,
  type RenderState,
} from "../../shared/render-dsl.ts";
import {
  initialSessionReviewLifecycle,
  requestDecision,
  type SessionReviewLifecycle,
} from "../session-review-lifecycle.ts";
import { SessionCapacityError } from "../session-registry.ts";

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

function makeBus(emitted: Array<Record<string, unknown>> = []): Bus {
  return {
    emit: () => {},
    emitToSession: (_sessionKey, payload) => emitted.push(payload),
    emitToProject: () => {},
    emitGlobal: () => {},
    subscribe: () => () => {},
  };
}

interface FakeHost {
  id: string;
  cwd: string;
  sessionId: string | null;
  role: "leader" | "minion";
  thinkingConfig: null;
  harnessName: string;
  workItemId: null;
  renderState: RenderState;
  reviewLifecycle: SessionReviewLifecycle;
  persist: ReturnType<typeof vi.fn>;
  bufferEvent: ReturnType<typeof vi.fn>;
}

function makeCtx(host: FakeHost | null): {
  ctx: CommandContext;
  startMock: ReturnType<typeof vi.fn>;
  host: FakeHost | null;
  emitted: Array<Record<string, unknown>>;
} {
  const startMock = vi.fn();
  const emitted: Array<Record<string, unknown>> = [];
  const liveHost = host
    ? {
        ...host,
        renderState: structuredClone(host.renderState),
        reviewLifecycle: { ...host.reviewLifecycle },
        persist: vi.fn(),
        bufferEvent: vi.fn(),
      }
    : null;
  const ctx: CommandContext = {
    registry: {
      get: (_key: string) => liveHost as unknown as ReturnType<CommandContext["registry"]["get"]>,
      start: startMock,
    } as unknown as CommandContext["registry"],
    bus: makeBus(emitted),
    generateKey: () => "key",
    maxSessions: 10,
    launchSession: async (options) => ({ sessionKey: options.sessionKey, harness: options.harness ?? "claude", model: options.initialModel ?? "", permissionMode: options.permissionMode ?? "auto", reasons: [] }),
  };
  return { ctx, startMock, host: liveHost, emitted };
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
  id: "sess-1",
  cwd: "/projects/foo",
  sessionId: "sdk-session-id",
  role: "leader",
  thinkingConfig: null,
  harnessName: "claude",
  workItemId: null,
  renderState: {
    layout: { title: "Input", columns: 2, gap: 12 },
    components: [{ id: "form-abc", type: "form", fields: [] }],
  },
  reviewLifecycle: requestDecision(
    initialSessionReviewLifecycle(),
    "Dashboard input requested",
  ),
  persist: vi.fn(),
  bufferEvent: vi.fn(),
};

describe("checkpoint form boundary regression", () => {
  it("detects an unanswered form nested inside a section", () => {
    const boundary = validateCheckpointBoundary({
      taskState: { tasks: new Map(), pendingWait: null, approval: null },
      renderComponents: [{
        id: "choices",
        type: "section",
        title: "Choices",
        components: [{ id: "nested-form", type: "form", fields: [] }],
      }],
    });

    expect(boundary).toEqual({ safe: false, reason: "form input is pending" });
  });
});

describe("shared recursive form selectors", () => {
  const components: RenderState["components"] = [{
    id: "outer",
    type: "tabs",
    tabs: [{
      id: "tab-1",
      label: "First",
      components: [{
        id: "inner",
        type: "section",
        title: "Nested",
        components: [
          { id: "pending", type: "form", fields: [] },
          {
            id: "answered",
            type: "form",
            fields: [],
            submittedAnswers: {},
          },
        ],
      }],
    }],
  }];

  it("finds unanswered forms recursively and excludes answered forms", () => {
    expect(findUnansweredForms(components).map((form) => form.id)).toEqual([
      "pending",
    ]);
  });

  it("finds answered forms by id at arbitrary nesting depth", () => {
    expect(findFormById(components, "answered")?.submittedAnswers).toEqual({});
  });
});

describe("submitForm — success path", () => {
  it("calls registry.start with the synthetic form prompt", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    expect(startMock).toHaveBeenCalledOnce();

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["sessionKey"]).toBe("sess-1");
    expect(opts["invocationKind"]).toBe("resume_open_run");
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

  it("records answers, advances the dashboard revision, and clears the decision", () => {
    const { ctx, host, emitted } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    expect(findFormById(host!.renderState.components, "form-abc")?.submittedAnswers)
      .toEqual({ env: "prod", canary: 25 });
    expect(host!.reviewLifecycle).toMatchObject({
      reviewState: "none",
      reviewReason: null,
      dashboardRevision: 1,
    });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "render_update",
      action: "set",
      components: host!.renderState.components,
    }));
  });

  it("submits a form nested inside a section", () => {
    const nestedHost: FakeHost = {
      ...DEFAULT_HOST,
      renderState: {
        layout: DEFAULT_HOST.renderState.layout,
        components: [{
          id: "section",
          type: "section",
          title: "Nested input",
          components: [{ id: "nested-form", type: "form", fields: [] }],
        }],
      },
    };
    const { ctx, host, startMock } = makeCtx(nestedHost);
    const { ws } = makeFakeWs();

    submitForm(
      ctx,
      baseCmd({ formComponentId: "nested-form", formAnswers: { choice: "A" } }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    expect(findFormById(host!.renderState.components, "nested-form")?.submittedAnswers)
      .toEqual({ choice: "A" });
    expect(startMock).toHaveBeenCalledOnce();
  });
});

describe("submitForm — validation errors", () => {
  it("keeps a legacy form pending when runtime capacity is unavailable", () => {
    const { ctx, startMock, host, emitted } = makeCtx(DEFAULT_HOST);
    startMock.mockImplementation(() => {
      throw new SessionCapacityError(1);
    });
    const { ws, sent } = makeFakeWs();

    submitForm(ctx, baseCmd({ requestId: "capacity-form" }),
      ws as unknown as Parameters<typeof submitForm>[2]);

    expect(findFormById(host!.renderState.components, "form-abc")?.submittedAnswers)
      .toBeUndefined();
    expect(host!.reviewLifecycle.reviewState).toBe("decision_needed");
    expect(emitted).toEqual([]);
    expect(sent[0]?.payload).toMatchObject({
      type: "control_response",
      command: "submit_form",
      success: false,
      code: "SESSION_CAPACITY_REACHED",
      requestId: "capacity-form",
    });
  });

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

  it("rejects an unknown form with a typed error and no lifecycle side effects", () => {
    const { ctx, startMock, host, emitted } = makeCtx(DEFAULT_HOST);
    const { ws, sent } = makeFakeWs();

    submitForm(
      ctx,
      baseCmd({ formComponentId: "missing-form" }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    expect(startMock).not.toHaveBeenCalled();
    expect(host!.reviewLifecycle.reviewState).toBe("decision_needed");
    expect(emitted).toEqual([]);
    expect(sent[0]?.payload).toMatchObject({
      type: "control_response",
      command: "submit_form",
      success: false,
      code: "FORM_NOT_FOUND",
    });
  });

  it("rejects an already-answered form with a typed error", () => {
    const answeredHost: FakeHost = {
      ...DEFAULT_HOST,
      renderState: {
        ...DEFAULT_HOST.renderState,
        components: [{
          id: "form-abc",
          type: "form",
          fields: [],
          submittedAnswers: { env: "staging" },
        }],
      },
    };
    const { ctx, startMock } = makeCtx(answeredHost);
    const { ws, sent } = makeFakeWs();

    submitForm(ctx, baseCmd({}), ws as unknown as Parameters<typeof submitForm>[2]);

    expect(startMock).not.toHaveBeenCalled();
    expect(sent[0]?.payload).toMatchObject({
      type: "control_response",
      command: "submit_form",
      success: false,
      code: "FORM_ALREADY_SUBMITTED",
    });
  });
});

describe("submitForm — prompt format", () => {
  it("prompt starts with the expected sentinel prefix", () => {
    const { ctx, startMock } = makeCtx(DEFAULT_HOST);
    const { ws } = makeFakeWs();

    submitForm(
      ctx,
      baseCmd({ formAnswers: { x: 1 } }),
      ws as unknown as Parameters<typeof submitForm>[2],
    );

    const opts = startMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const prompt = String(opts["prompt"]);
    expect(prompt).toMatch(
      /^\[The user submitted form 'form-abc' with the following answers:\]/,
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
