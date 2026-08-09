import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket, WebSocketServer } from "ws";
import { createBus } from "../../server/bus.ts";
import { dispatchCommand } from "../../server/commands/index.ts";
import type {
  CommandContext,
  WsCommand,
} from "../../server/commands/types.ts";
import { SessionHost } from "../../server/session-host.ts";
import { SessionRegistry } from "../../server/session-registry.ts";
import {
  closePersistDb,
  disablePersistence,
  openPersistDb,
} from "../../server/session-persist.ts";
import { getRenderState } from "../../server/session-repo.ts";
import {
  requestDecision,
} from "../../server/session-review-lifecycle.ts";
import {
  applyRenderMessage,
  emptyRenderState,
  findFormById,
  type RenderComponent,
  type RenderMessage,
} from "../../shared/render-dsl.ts";

interface Envelope {
  topic?: string;
  type?: string;
  [key: string]: unknown;
}

function rig(components: RenderComponent[]) {
  const busSent: Envelope[] = [];
  const bus = createBus({
    clients: new Set(),
  } as unknown as WebSocketServer);
  bus.subscribe((envelope) => busSent.push(envelope as Envelope));

  const registry = new SessionRegistry();
  registry.setDeps({
    bus,
    startChildSession: () => {},
    forEachLeaderTaskState: () => {},
  });
  const host = new SessionHost("leader-1", "/proj");
  host.harnessName = "echo";
  host.renderState = {
    layout: { title: "Decision", columns: 2, gap: 12 },
    components,
  };
  host.reviewLifecycle = requestDecision(
    host.reviewLifecycle,
    "Dashboard input requested",
  );
  host.persist();
  (registry as unknown as { map: Map<string, SessionHost> }).map.set(
    host.id,
    host,
  );

  const wsSent: Envelope[] = [];
  const ws = {
    readyState: 1,
    send(raw: string) {
      wsSent.push(JSON.parse(raw) as Envelope);
    },
  } as unknown as WebSocket;
  const ctx: CommandContext = {
    registry,
    bus,
    generateKey: () => "generated",
    maxSessions: 10,
    launchSession: async (options) => ({
      sessionKey: options.sessionKey,
      harness: options.harness ?? "echo",
      model: options.initialModel ?? "",
      permissionMode: options.permissionMode ?? "auto",
      reasons: [],
    }),
  };
  return { busSent, ctx, host, ws, wsSent };
}

function command(
  formComponentId: string,
  formAnswers: Record<string, unknown> = { choice: "A" },
): WsCommand {
  return {
    type: "submit_form",
    sessionKey: "leader-1",
    requestId: "request-1",
    formComponentId,
    formAnswers,
  };
}

function renderMessage(envelope: Envelope): RenderMessage {
  const {
    topic: _topic,
    type: _type,
    leaderSessionKey: _leaderSessionKey,
    ...message
  } = envelope;
  return message as unknown as RenderMessage;
}

beforeEach(() => {
  closePersistDb();
  openPersistDb(":memory:");
});

afterEach(() => {
  disablePersistence();
});

describe("submit_form command lifecycle contract", () => {
  it("persists answers, clears the decision, converges the client, and resumes", async () => {
    const form: RenderComponent = {
      id: "decision-form",
      type: "form",
      fields: [],
    };
    const { busSent, ctx, host, ws } = rig([form]);

    dispatchCommand(ctx, command("decision-form"), ws);

    expect(host.reviewLifecycle).toMatchObject({
      reviewState: "none",
      reviewReason: null,
      dashboardRevision: 1,
    });
    const renderUpdate = busSent.find(
      (envelope) => envelope.type === "render_update",
    );
    expect(renderUpdate).toBeTruthy();
    const clientState = applyRenderMessage(
      emptyRenderState(),
      renderMessage(renderUpdate!),
    );
    expect(findFormById(clientState.components, "decision-form")?.submittedAnswers)
      .toEqual({ choice: "A" });

    const stored = getRenderState(openPersistDb(), host.id);
    expect(findFormById(stored!.components, "decision-form")?.submittedAnswers)
      .toEqual({ choice: "A" });
    await vi.waitFor(() => {
      expect(busSent).toContainEqual(expect.objectContaining({
        type: "sdk_event",
        event: expect.objectContaining({
          kind: "text",
          text: expect.stringContaining("decision-form"),
        }),
      }));
    });
  });

  it("rejects an unknown form id without resuming", () => {
    const { busSent, ctx, host, ws, wsSent } = rig([]);

    dispatchCommand(ctx, command("missing"), ws);

    expect(host.reviewLifecycle.reviewState).toBe("decision_needed");
    expect(busSent).toEqual([]);
    expect(wsSent).toContainEqual(expect.objectContaining({
      type: "control_response",
      command: "submit_form",
      success: false,
      code: "FORM_NOT_FOUND",
    }));
  });

  it("rejects an already-answered form without replacing its answers", () => {
    const answered: RenderComponent = {
      id: "answered",
      type: "form",
      fields: [],
      submittedAnswers: { choice: "original" },
    };
    const { ctx, host, ws, wsSent } = rig([answered]);

    dispatchCommand(ctx, command("answered", { choice: "replacement" }), ws);

    expect(findFormById(host.renderState!.components, "answered")?.submittedAnswers)
      .toEqual({ choice: "original" });
    expect(wsSent).toContainEqual(expect.objectContaining({
      type: "control_response",
      success: false,
      code: "FORM_ALREADY_SUBMITTED",
    }));
  });

  it("accepts and persists a form nested inside a section", async () => {
    const nested: RenderComponent = {
      id: "section",
      type: "section",
      title: "Nested",
      components: [{ id: "nested-form", type: "form", fields: [] }],
    };
    const { ctx, host, ws } = rig([nested]);

    dispatchCommand(ctx, command("nested-form", { nested: true }), ws);

    expect(findFormById(host.renderState!.components, "nested-form")?.submittedAnswers)
      .toEqual({ nested: true });
    const stored = getRenderState(openPersistDb(), host.id);
    expect(findFormById(stored!.components, "nested-form")?.submittedAnswers)
      .toEqual({ nested: true });
    await vi.waitFor(() => expect(host.status).toBe("idle"));
  });
});
