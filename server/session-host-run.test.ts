/**
 * Tests for `buildHarnessStartOpts` — capability gating.
 *
 * Verifies that:
 *   - harness.builtInTools + mcpToolNames are included in allowedTools
 *   - thinking config is gated on capabilities.thinking and model support
 *   - `pathToClaudeCodeExecutable` is NOT included in HarnessStartOptions
 *     (it's internal to ClaudeHarness, not in the normalized contract)
 *   - tool names from toolResult merge correctly
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHarnessStartOpts, ensureWorktree, sessionHostLogFields } from "./session-host-run.ts";
import type { AgentHarness, HarnessCapabilities } from "./harness/types.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./agents/types.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import type { ThinkingConfig } from "./session-host-config.ts";

// ── Fixture builders ─────────────────────────────────────────────────────────

function fakeHarness(
  name: string,
  caps: Partial<HarnessCapabilities>,
  builtIns: string[] = [],
): AgentHarness {
  return {
    name,
    exposure: "test",
    capabilities: {
      mutationInterception: "none",
      thinking: false,
      promptCaching: false,
      mcp: false,
      permissionPrompts: false,
      resume: false,
      partialMessages: false,
      builtInFilesystem: false,
      ...caps,
    },
    builtInTools: builtIns,
    async checkReadiness() {
      return { state: "ready", runtime: { available: true, source: "sdk_bundled" }, auth: { authenticated: true, source: "unknown" } };
    },
    start: () => ({
      events: (async function* () {})(),
      control: { abort: () => {} },
    }),
    staticInfo: () => ({
      models: [],
      commands: [],
      agents: [],
      account: { provider: "test" },
    }),
    registerTools() {},
    resolveModel: () => null,
  };
}

function fakeHost(
  overrides: {
    model?: string | null;
    thinkingConfig?: ThinkingConfig | null;
    worktree?: null;
  } = {},
): SessionHost {
  return {
    id: "test-session",
    cwd: "/test",
    model: overrides.model ?? null,
    thinkingConfig: overrides.thinkingConfig ?? null,
    worktree: overrides.worktree ?? null,
  } as unknown as SessionHost;
}

function fakeOpts(overrides: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return {
    sessionKey: "test-session",
    prompt: "hello",
    cwd: "/test",
    ...overrides,
  };
}

const fakeAgentType: AgentType = {
  id: "default",
  wantsWorktree: false,
  buildSystemPrompt: () => undefined,
  getToolGroups: () => ({ toolGroups: {}, mcpToolNames: [] }),
};

const fakeCtx = {} as AgentTypeContext;
const fakeToolResult: AgentToolResult = { toolGroups: {}, mcpToolNames: [] };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionHost observability context", () => {
  it("correlates compatibility session identity with canonical work and run identity", () => {
    expect(sessionHostLogFields({
      id: "legacy-session",
      runKey: "run-9",
      workItemId: "work-4",
      runKind: "child",
      parentRunKey: "run-root",
      taskId: "task-2",
    } as SessionHost)).toEqual({
      sessionKey: "legacy-session",
      runKey: "run-9",
      workItemId: "work-4",
      runKind: "child",
      parentRunKey: "run-root",
      taskId: "task-2",
    });
  });
});

describe("ensureWorktree safety boundary", () => {
  it("fails closed instead of running in the shared directory when isolation cannot be provisioned", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "minions-non-git-"));
    const events: unknown[] = [];
    const host = { id: "safe-run", cwd, worktree: null, worktreeIsolation: true,
      runKey: "safe-run", workItemId: "work", runKind: "primary",
      parentRunKey: null, taskId: null } as unknown as SessionHost;
    const leader = { ...fakeAgentType, wantsWorktree: true };
    try {
      await expect(ensureWorktree(host, fakeOpts({ cwd, worktreeIsolation: true }),
        { emitToSession: (_key: string, event: unknown) => events.push(event) } as never,
        leader)).rejects.toThrow(/requires a Git repository/);
      expect(host.worktreeIsolation).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "worktree_failed" }));
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe("buildHarnessStartOpts — capability gating", () => {
  it("retains resumeId for open-run resumes and clears it for provider continuations", () => {
    const input = {
      host: fakeHost(),
      agentType: fakeAgentType,
      agentCtx: fakeCtx,
      toolResult: fakeToolResult,
      abortController: new AbortController(),
      harness: fakeHarness("fake", {}),
      prompt: "hello",
    };
    const resumed = buildHarnessStartOpts({
      ...input,
      opts: fakeOpts({ invocationKind: "resume_open_run", resumeId: "provider-1" }),
    });
    const continued = buildHarnessStartOpts({
      ...input,
      opts: fakeOpts({ invocationKind: "provider_continuation", resumeId: "must-not-leak" }),
    });

    expect(resumed.startOpts.resumeId).toBe("provider-1");
    expect(continued.startOpts.resumeId).toBeUndefined();
  });

  it("includes harness.builtInTools in allowedTools", () => {
    const harness = fakeHarness("fake", {}, ["Read", "Write", "Bash"]);
    const { allowedTools } = buildHarnessStartOpts({
      host: fakeHost(),
      opts: fakeOpts(),
      agentType: fakeAgentType,
      agentCtx: fakeCtx,
      toolResult: fakeToolResult,
      abortController: new AbortController(),
      harness,
      prompt: "hello",
    });
    expect(allowedTools).toContain("Read");
    expect(allowedTools).toContain("Write");
    expect(allowedTools).toContain("Bash");
  });

  it("merges mcpToolNames and externalMcpToolNames alongside builtInTools", () => {
    const harness = fakeHarness("fake", {}, ["Glob"]);
    const toolResult: AgentToolResult = { toolGroups: {}, mcpToolNames: ["mcp__srv__foo"] };
    const opts = fakeOpts({ externalMcpToolNames: ["mcp__ext__bar"] });
    const { allowedTools } = buildHarnessStartOpts({
      host: fakeHost(),
      opts,
      agentType: fakeAgentType,
      agentCtx: fakeCtx,
      toolResult,
      abortController: new AbortController(),
      harness,
      prompt: "hello",
    });
    expect(allowedTools).toContain("Glob");
    expect(allowedTools).toContain("mcp__srv__foo");
    expect(allowedTools).toContain("mcp__ext__bar");
  });

  it("derives MCP allowed tool names from registered tool groups", () => {
    const harness = fakeHarness("fake", {}, []);
    const toolResult: AgentToolResult = {
      toolGroups: { "task-manager": [{ name: "checkpoint_session", description: "", inputSchema: {} as never, handler: async () => ({ content: [] }) }] },
      mcpToolNames: [],
    };
    const { allowedTools } = buildHarnessStartOpts({
      host: fakeHost(),
      opts: fakeOpts(),
      agentType: fakeAgentType,
      agentCtx: fakeCtx,
      toolResult,
      abortController: new AbortController(),
      harness,
      prompt: "hello",
    });

    expect(allowedTools).toContain("mcp__task-manager__checkpoint_session");
  });

  describe("thinking gating", () => {
    it("omits thinking when capabilities.thinking is false, even if thinkingConfig is set", () => {
      const harness = fakeHarness("fake", { thinking: false });
      const host = fakeHost({
        model: "sonnet",
        thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      });
      const { startOpts } = buildHarnessStartOpts({
        host,
        opts: fakeOpts(),
        agentType: fakeAgentType,
        agentCtx: fakeCtx,
        toolResult: fakeToolResult,
        abortController: new AbortController(),
        harness,
        prompt: "hello",
      });
      expect(startOpts.thinking).toBeUndefined();
    });

    it("sets thinking when capabilities.thinking is true, config.enabled, and model supports adaptive", () => {
      const harness = fakeHarness("claude", { thinking: true });
      const host = fakeHost({
        model: "sonnet",
        thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      });
      const { startOpts } = buildHarnessStartOpts({
        host,
        opts: fakeOpts(),
        agentType: fakeAgentType,
        agentCtx: fakeCtx,
        toolResult: fakeToolResult,
        abortController: new AbortController(),
        harness,
        prompt: "hello",
      });
      expect(startOpts.thinking).toEqual({ effort: "high", display: "summarized" });
    });

    it("omits thinking when model does not support adaptive, even if all other conditions met", () => {
      const harness = fakeHarness("claude", { thinking: true });
      const host = fakeHost({
        model: "claude-haiku-4-5",
        thinkingConfig: { enabled: true, effort: "medium", display: "omitted" },
      });
      const { startOpts } = buildHarnessStartOpts({
        host,
        opts: fakeOpts(),
        agentType: fakeAgentType,
        agentCtx: fakeCtx,
        toolResult: fakeToolResult,
        abortController: new AbortController(),
        harness,
        prompt: "hello",
      });
      expect(startOpts.thinking).toBeUndefined();
    });

    it("sets thinking for non-Claude thinking-capable harnesses without Claude model gating", () => {
      const harness = fakeHarness("codex", { thinking: true });
      const host = fakeHost({
        model: "gpt-5.5",
        thinkingConfig: { enabled: true, effort: "medium", display: "omitted" },
      });
      const { startOpts } = buildHarnessStartOpts({
        host,
        opts: fakeOpts(),
        agentType: fakeAgentType,
        agentCtx: fakeCtx,
        toolResult: fakeToolResult,
        abortController: new AbortController(),
        harness,
        prompt: "hello",
      });
      expect(startOpts.thinking).toEqual({ effort: "medium", display: "omitted" });
    });

    it("preserves extra-high reasoning for Codex", () => {
      const harness = fakeHarness("codex", { thinking: true });
      const host = fakeHost({
        model: "gpt-5.6-sol",
        thinkingConfig: { enabled: true, effort: "xhigh", display: "summarized" },
      });
      const { startOpts } = buildHarnessStartOpts({
        host,
        opts: fakeOpts(),
        agentType: fakeAgentType,
        agentCtx: fakeCtx,
        toolResult: fakeToolResult,
        abortController: new AbortController(),
        harness,
        prompt: "hello",
      });
      expect(startOpts.thinking).toEqual({ effort: "xhigh", display: "summarized" });
    });
  });

  describe("builtInFilesystem capability", () => {
    it("harness with builtInFilesystem=false is created without error", () => {
      const harness = fakeHarness("openai", { builtInFilesystem: false });
      expect(() =>
        buildHarnessStartOpts({
          host: fakeHost(),
          opts: fakeOpts(),
          agentType: fakeAgentType,
          agentCtx: fakeCtx,
          toolResult: fakeToolResult,
          abortController: new AbortController(),
          harness,
          prompt: "hello",
        }),
      ).not.toThrow();
    });

    it("harness with builtInFilesystem=true is created without error", () => {
      const harness = fakeHarness("claude", { builtInFilesystem: true });
      expect(() =>
        buildHarnessStartOpts({
          host: fakeHost(),
          opts: fakeOpts(),
          agentType: fakeAgentType,
          agentCtx: fakeCtx,
          toolResult: fakeToolResult,
          abortController: new AbortController(),
          harness,
          prompt: "hello",
        }),
      ).not.toThrow();
    });
  });
});
