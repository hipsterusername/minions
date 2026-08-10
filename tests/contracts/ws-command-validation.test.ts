/**
 * Contract: inbound WebSocket commands are validated before dispatch.
 *
 * This test exercises the full path a client message takes:
 *   raw string → JSON.parse → validateWsCommand → dispatch (or error reply)
 *
 * It is a contract test rather than a unit test because it crosses the
 * boundary between `ws-connection.ts` (the WS listener) and
 * `commands/schemas.ts` (the validation layer). If either side drifts from
 * the agreed contract — e.g. validation is removed, or the listener stops
 * calling it — this suite fails.
 *
 * Pattern mirrors `ws-envelope.test.ts`: fake WebSocket as EventEmitter,
 * real `attachConnectionListeners` wired with a spy dispatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { attachConnectionListeners } from "../../server/ws-connection.ts";
import type { ConnectionDeps } from "../../server/ws-connection.ts";
import { encodeLeaderPromptCustomization } from "../../shared/leader-prompt.ts";

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

function makeDeps(overrides: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return {
    snapshotSessions: () => [],
    dispatch: vi.fn(),
    ...overrides,
  };
}

function send(ws: FakeWs, payload: unknown): void {
  ws.emit("message", Buffer.from(JSON.stringify(payload)));
}

/** Discard the initial session_list sent on attach. */
function clearInitialMessages(ws: FakeWs): void {
  ws.sent = [];
}

describe("contract: inbound WS command validation", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // ── Valid commands reach dispatch ──────────────────────────

  it("dispatches a valid list_sessions command to the handler", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    send(ws, { type: "list_sessions" });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [cmd] = dispatch.mock.calls[0]!;
    expect((cmd as { type: string }).type).toBe("list_sessions");
    expect(ws.sent).toHaveLength(0); // no error reply
  });

  it("dispatches a valid create_session command preserving all fields", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    const payload = {
      type: "create_session",
      sessionKey: "sk-1",
      cwd: "/projects/foo",
      workspaceId: "8dcf241e-52b8-4d50-a2f3-9b12fdab7a1c",
      sandboxPolicy: {
        filesystemScope: "workspace-write",
        approvalPolicy: "on-request",
      },
      role: "leader",
      worktreeIsolation: true,
      model: "claude-opus-4-5",
      prompt: "Hello",
      systemPrompt: encodeLeaderPromptCustomization({
        promptPrefix: "Focus on accessibility.",
        skillsAddendum: "# Active Skills\n\nReview the API.",
      }),
      skillIds: ["review"],
      skillValues: { review: { target: "API" } },
    };
    send(ws, payload);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [cmd] = dispatch.mock.calls[0]!;
    expect(cmd).toMatchObject(payload);
    expect(ws.sent).toHaveLength(0);
  });

  it("dispatches structured Leader customization without a full client prompt", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    const payload = {
      type: "send_message",
      sessionKey: "leader-1",
      prompt: "Continue.",
      systemPrompt: encodeLeaderPromptCustomization({
        promptPrefix: "Use terse explanations.",
      }),
    };
    send(ws, payload);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining(payload), expect.anything());
    expect(ws.sent).toHaveLength(0);
  });

  it("rejects invalid sandbox posture before dispatch", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    send(ws, {
      type: "create_session",
      workspaceId: "8dcf241e-52b8-4d50-a2f3-9b12fdab7a1c",
      sandboxPolicy: {
        filesystemScope: "host-write",
        approvalPolicy: "on-request",
      },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!).message).toContain("filesystemScope");
  });

  it("rejects create_session when a Leader customization envelope is malformed", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    send(ws, {
      type: "create_session",
      role: "leader",
      prompt: "Start.",
      systemPrompt: '{"version":1,"promptPrefix":"missing skills"}',
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!).message).toContain("malformed customization envelope");
  });

  it("dispatches a valid send_message command with attachments", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    send(ws, {
      type: "send_message",
      sessionKey: "sk-2",
      prompt: "What is in this image?",
      attachments: [{ kind: "image", mediaType: "image/png", data: "abc123" }],
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ws.sent).toHaveLength(0);
  });

  // ── Invalid commands are rejected with an error reply ──────

  it("sends an error reply and does NOT dispatch for an unknown command type", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    send(ws, { type: "totally_unknown_command" });

    expect(dispatch).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    const reply = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(reply.type).toBe("error");
    expect(String(reply.message)).toContain("Unknown command type");
  });

  it("sends an error reply and does NOT dispatch when type field is missing", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    send(ws, { sessionKey: "sk-1" }); // no `type`

    expect(dispatch).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    const reply = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(reply.type).toBe("error");
    expect(String(reply.message)).toContain('"type"');
  });

  it("sends an error reply and does NOT dispatch when a field has the wrong type", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    // worktreeIsolation must be boolean, not string
    send(ws, { type: "create_session", worktreeIsolation: "yes" });

    expect(dispatch).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    const reply = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(reply.type).toBe("error");
    expect(String(reply.message)).toContain("create_session");
  });

  it("sends an error reply and does NOT dispatch for malformed JSON", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    ws.emit("message", Buffer.from("not valid json {{{"));

    expect(dispatch).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    const reply = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(reply.type).toBe("error");
  });

  it("sends an error reply when the payload is a JSON array (not an object)", () => {
    const ws = new FakeWs();
    const dispatch = vi.fn();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps({ dispatch }));
    clearInitialMessages(ws);

    send(ws, [{ type: "list_sessions" }]);

    expect(dispatch).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    const reply = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(reply.type).toBe("error");
    expect(String(reply.message)).toContain("JSON object");
  });

  // ── Error reply is a valid server envelope ─────────────────

  it("error reply for an invalid command is a well-formed server message", () => {
    const ws = new FakeWs();
    attachConnectionListeners(ws as unknown as WebSocket, makeDeps());
    clearInitialMessages(ws);

    send(ws, { type: "bad_type" });

    const raw = ws.sent[0]!;
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    // Must be a plain object with at least `type` and `message`.
    expect(typeof envelope).toBe("object");
    expect(envelope.type).toBe("error");
    expect(typeof envelope.message).toBe("string");
    expect((envelope.message as string).length).toBeGreaterThan(0);
  });
});
