import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeInfo } from "../worktree-types.ts";
import type { WorkItemService } from "../work-item-service.ts";
import { initialWorkItemLifecycle } from "../../shared/work-item-lifecycle.ts";
import { setup, cmd as baseCommand } from "../../tests/support/server-command-harness.ts";
import { encodeLeaderPromptCustomization } from "../../shared/leader-prompt.ts";
import { SessionCapacityError } from "../session-registry.ts";

interface StartCall {
  sessionKey: string;
  prompt: string;
  cwd: string;
  resumeId?: string;
  systemPrompt?: string;
  role?: string;
  thinkingConfig?: unknown;
  attachments?: unknown;
  harness?: string;
  skillIds?: string[];
  skillValues?: Record<string, Record<string, string>>;
}

const createWorktreeCalls: { cwd: string; key: string }[] = [];
// Existing clients omit correlation; receipt tests opt in explicitly.
const cmd = (overrides: Parameters<typeof baseCommand>[0]) =>
  baseCommand({ requestId: undefined, ...overrides });
let createWorktreeShouldFail = false;
const fakeWorktreeInfo: WorktreeInfo = {
  path: "/p/.canvas-worktrees/k",
  branch: "canvas/k",
  leaderSessionKey: "leader-1",
  createdAt: 0,
  projectPath: "/p",
  lifecycle: "active",
};

vi.mock("../worktree.ts", () => ({
  createWorktree: vi.fn(async (cwd: string, key: string) => {
    createWorktreeCalls.push({ cwd, key });
    if (createWorktreeShouldFail) throw new Error("git failed");
    return fakeWorktreeInfo;
  }),
}));

import { sendMessage } from "./send-message.ts";

describe("correlated message receipts", () => {
  it("confirms acceptance only after the legacy turn starts", async () => {
    const h = setup();
    const { calls } = captureRegistryStart(h);
    await sendMessage(h.ctx, cmd({ type: "send_message", sessionKey: h.host.id,
      prompt: "keep this text", requestId: "send-1" }), h.ws);
    expect(calls).toHaveLength(1);
    expect(h.wsSent).toContainEqual(expect.objectContaining({ type: "control_response",
      command: "send_message", requestId: "send-1", success: true }));
  });

  it("correlates busy rejection without starting another turn", async () => {
    const h = setup();
    h.host.status = "running";
    const { calls } = captureRegistryStart(h);
    await sendMessage(h.ctx, cmd({ type: "send_message", sessionKey: h.host.id,
      prompt: "keep this text", requestId: "send-2" }), h.ws);
    expect(calls).toHaveLength(0);
    expect(h.wsSent).toContainEqual(expect.objectContaining({ type: "control_response",
      command: "send_message", requestId: "send-2", success: false, code: "SESSION_BUSY" }));
  });

  it("does not confirm a send when worktree creation fails", async () => {
    const h = setup();
    h.host.role = "leader";
    h.host.worktreeIsolation = true;
    h.host.worktree = null;
    createWorktreeShouldFail = true;
    await sendMessage(h.ctx, cmd({ type: "send_message", sessionKey: h.host.id,
      prompt: "keep this text", requestId: "send-3" }), h.ws);
    await vi.waitFor(() => expect(h.wsSent).toContainEqual(expect.objectContaining({
      type: "control_response", command: "send_message", requestId: "send-3", success: false,
    })));
    expect(h.wsSent.some(message => message["type"] === "control_response" && message["success"] === true)).toBe(false);
  });
});

beforeEach(() => {
  createWorktreeCalls.length = 0;
  createWorktreeShouldFail = false;
});

afterEach(() => {
  createWorktreeCalls.length = 0;
});

function captureRegistryStart(
  h: ReturnType<typeof setup>,
): { calls: StartCall[] } {
  const calls: StartCall[] = [];
  // The registry has a `start()` method we want to spy on. Stub it
  // so SendMessage's real call path is exercised but no SDK is opened.
  (h.ctx.registry as unknown as { start: (opts: StartCall) => void }).start = (
    opts: StartCall,
  ) => {
    calls.push(opts);
  };
  return { calls };
}

describe("send_message", () => {
  it("rejects a busy legacy message before changing approval or starting a provider", async () => {
    const h = setup({ status: "running" });
    const { calls } = captureRegistryStart(h);
    await sendMessage(h.ctx, cmd({ type: "send_message", prompt: "second message" }), h.ws);
    expect(calls).toEqual([]);
    expect(h.wsSent[0]).toMatchObject({ type: "session_error", code: "SESSION_BUSY" });
    expect(createWorktreeCalls).toEqual([]);
  });

  it("reserves a legacy follow-up while its worktree is being created", async () => {
    const h = setup(); h.host.role = "leader"; h.host.worktreeIsolation = true;
    captureRegistryStart(h);
    const first = sendMessage(h.ctx, cmd({ type: "send_message", prompt: "first" }), h.ws);
    const second = sendMessage(h.ctx, cmd({ type: "send_message", prompt: "second" }), h.ws);
    await Promise.all([first, second]);
    expect(createWorktreeCalls).toHaveLength(1);
    expect(h.wsSent).toContainEqual(expect.objectContaining({ code: "SESSION_BUSY" }));
  });

  it("resumes the session with prompt + resumeId via registry.start (default branch)", () => {
    const h = setup();
    h.host.sessionId = "sdk-id";
    h.host.role = "default";
    const { calls } = captureRegistryStart(h);

    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "leader-1",
        prompt: "hello",
        displayPrompt: "hello",
        systemPrompt: "be helpful",
      }),
      h.ws,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionKey: "leader-1",
      invocationKind: "new_run",
      prompt: "hello",
      displayPrompt: "hello",
      cwd: "/proj",
      resumeId: "sdk-id",
      systemPrompt: "be helpful",
      role: "default",
    });
    // No worktree creation when isolation is off.
    expect(createWorktreeCalls).toHaveLength(0);
  });

  it("synchronizes follow-up skill state into the resumed host invocation", () => {
    const h = setup();
    h.host.role = "leader";
    const { calls } = captureRegistryStart(h);
    sendMessage(h.ctx, cmd({
      type: "send_message", sessionKey: "leader-1", prompt: "use the recipe",
      skillIds: ["review", "docs"],
      skillValues: { review: { depth: "high" } },
    }), h.ws);
    expect(calls[0]).toMatchObject({
      skillIds: ["review", "docs"],
      skillValues: { review: { depth: "high" } },
    });
  });

  it("forwards only a trimmed Leader prompt prefix while preserving non-leader behavior", () => {
    const h = setup();
    h.host.role = "leader";
    const { calls } = captureRegistryStart(h);

    sendMessage(h.ctx, cmd({
      type: "send_message",
      sessionKey: "leader-1",
      prompt: "continue",
      systemPrompt: encodeLeaderPromptCustomization({
        promptPrefix: "  Focus on accessibility.  ",
      }),
    }), h.ws);

    expect(calls[0]?.systemPrompt).toContain("Focus on accessibility.");
  });

  it("rejects a malformed structured customization for a Leader session", () => {
    const h = setup();
    h.host.role = "leader";
    const { calls } = captureRegistryStart(h);

    sendMessage(h.ctx, cmd({
      type: "send_message",
      sessionKey: "leader-1",
      prompt: "continue",
      systemPrompt: '{"version":1,"promptPrefix":"missing skills"}',
    }), h.ws);

    expect(calls).toEqual([]);
    expect(h.wsSent[0]?.message).toContain("malformed customization envelope");
  });

  it("rejects with a global error when sessionKey or prompt is missing", () => {
    const h = setup();
    sendMessage(
      h.ctx,
      cmd({ type: "send_message", sessionKey: undefined, prompt: "x" }),
      h.ws,
    );
    sendMessage(
      h.ctx,
      cmd({ type: "send_message", sessionKey: "leader-1", prompt: undefined }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(2);
    for (const sent of h.wsSent) {
      expect(sent["type"]).toBe("error");
      expect(sent["topic"]).toBe("global");
    }
  });

  it("rejects with a session-scoped error when the session is unknown", () => {
    const h = setup();
    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "ghost",
        prompt: "x",
      }),
      h.ws,
    );
    expect(h.wsSent).toHaveLength(1);
    expect(h.wsSent[0]!["type"]).toBe("error");
    expect(h.wsSent[0]!["topic"]).toBe("session:ghost");
  });

  it("reports a typed session error when a retained host cannot resume at capacity", async () => {
    const h = setup();
    h.ctx.registry.start = () => {
      throw new SessionCapacityError(1);
    };

    await sendMessage(h.ctx, cmd({
      type: "send_message",
      sessionKey: h.host.id,
      prompt: "resume",
    }), h.ws);

    expect(h.wsSent).toContainEqual(expect.objectContaining({
      type: "session_error",
      topic: `session:${h.host.id}`,
      sessionKey: h.host.id,
      code: "SESSION_CAPACITY_REACHED",
    }));
    expect(h.host.status).toBe("idle");
  });

  it("bridges a legacy continuation into a canonical interrupted-run restart", async () => {
    const h = setup();
    h.host.workItemId = "work-1";
    h.host.taskState = {
      tasks: new Map(), pendingWait: null,
      approval: { requested: true, requestedAt: 1, summary: "Review", diff: null },
    };
    const { calls } = captureRegistryStart(h);
    const detail = { workItem: { id: "work-1", projectId: "project-1", projectPath: "/proj",
      title: "Task", lifecycle: { ...initialWorkItemLifecycle(), runtimeState: "inactive" as const,
        outcome: "interrupted" as const, lifecycleRevision: 4 }, waitKind: null,
      currentRunKey: h.host.runKey, iteration: 1,
      lastTransitionAt: 1, createdAt: 1, updatedAt: 1 },
      bindings: [], currentRun: null, runs: [], nextCursor: null };
    const continueWorkItem = vi.fn(async () => detail);
    h.ctx.workItems = { get: vi.fn(async () => detail),
      continue: continueWorkItem } as unknown as WorkItemService;
    await sendMessage(h.ctx, cmd({
      type: "send_message", sessionKey: h.host.id, prompt: "Continue old row",
      skillIds: ["review"], skillValues: { review: { depth: "high" } },
    }), h.ws);

    expect(calls).toEqual([]);
    expect(h.host.taskState.approval?.requested).toBe(true);
    expect(continueWorkItem).toHaveBeenCalledWith(expect.objectContaining({ workItemId: "work-1",
      prompt: "Continue old row", expectedLifecycleRevision: 4,
      expectedCurrentRunKey: h.host.runKey, skillIds: ["review"],
      skillValues: { review: { depth: "high" } } }));
    expect(h.wsSent).toEqual([]);
  });

  it("when approval was requested, wraps the prompt as a change request and emits approval_resolved", () => {
    const h = setup();
    h.host.taskState = {
      tasks: new Map(),
      pendingWait: null,
      approval: {
        requested: true,
        requestedAt: 0,
        summary: "x",
        diff: null,
      },
    };
    const { calls } = captureRegistryStart(h);

    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "leader-1",
        prompt: "use snake_case instead",
      }),
      h.ws,
    );

    // Approval state cleared.
    expect(h.host.taskState.approval).toBeNull();

    // Prompt wrapped — assert the structure (lead-in + user feedback),
    // not the literal copy.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("use snake_case instead");
    expect(calls[0]!.prompt).toMatch(/changes/i);

    // approval_resolved emitted with the change-request action.
    const resolved = h.busSent.find((e) => e.type === "approval_resolved");
    expect(resolved).toBeDefined();
    expect(resolved!["action"]).toBe("changes_requested");
  });

  it("when worktreeIsolation is on but no worktree exists, creates one then resumes inside it", async () => {
    const h = setup();
    h.host.persist = vi.fn(); // This command test does not open a persistence database.
    h.host.role = "leader";
    h.host.worktreeIsolation = true;
    h.host.worktree = null;
    const { calls } = captureRegistryStart(h);

    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "leader-1",
        prompt: "next iteration",
      }),
      h.ws,
    );

    // The createWorktree promise resolves on the next microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createWorktreeCalls).toEqual([{ cwd: "/proj", key: "leader-1" }]);
    expect(h.host.worktree).toBe(fakeWorktreeInfo);
    expect(h.host.cwd).toBe("/p/.canvas-worktrees/k");

    // worktree_created emitted.
    expect(h.busSent.find((e) => e.type === "worktree_created")).toBeDefined();

    // registry.start called AFTER the worktree creation, with the new cwd.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe("/p/.canvas-worktrees/k");
  });

  it("creates a fresh follow-up worktree from the project root when cwd is a stale worktree path", async () => {
    const h = setup();
    h.host.persist = vi.fn();
    h.host.role = "leader";
    h.host.worktreeIsolation = true;
    h.host.worktree = null;
    h.host.cwd = "/p/.canvas-worktrees/leader-1";
    const { calls } = captureRegistryStart(h);

    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "leader-1",
        prompt: "next iteration",
      }),
      h.ws,
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createWorktreeCalls).toEqual([{ cwd: "/p", key: "leader-1" }]);
    expect(calls[0]!.cwd).toBe("/p/.canvas-worktrees/k");
  });

  it("when createWorktree fails, emits worktree_failed and does NOT resume the session", async () => {
    createWorktreeShouldFail = true;
    const h = setup();
    h.host.role = "leader";
    h.host.worktreeIsolation = true;
    h.host.worktree = null;
    const { calls } = captureRegistryStart(h);

    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "leader-1",
        prompt: "x",
      }),
      h.ws,
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(0);
    const failed = h.busSent.find((e) => e.type === "worktree_failed");
    expect(failed).toBeDefined();
    expect(failed!["error"]).toContain("git failed");
  });

  it("resumes with the host's existing harnessName, even when a different harness is on the cmd", () => {
    const h = setup();
    h.host.harnessName = "echo";
    const { calls } = captureRegistryStart(h);

    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "leader-1",
        prompt: "next turn",
        // cmd-supplied harness override is intentionally ignored mid-thread
        harness: "claude",
      }),
      h.ws,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.harness).toBe("echo");
  });

  it("forwards a refreshed thinkingConfig from the cmd onto the resume call", () => {
    const h = setup();
    h.host.thinkingConfig = {
      enabled: false,
      effort: "low",
      display: "summarized",
    };
    const { calls } = captureRegistryStart(h);

    sendMessage(
      h.ctx,
      cmd({
        type: "send_message",
        sessionKey: "leader-1",
        prompt: "p",
        thinkingConfig: {
          enabled: true,
          effort: "max",
          display: "summarized",
        },
      }),
      h.ws,
    );

    expect(calls[0]!.thinkingConfig).toEqual({
      enabled: true,
      effort: "max",
      display: "summarized",
    });
  });
});
