/**
 * ClaudeHarness — AgentHarness implementation for the Anthropic Claude SDK.
 *
 * Wraps the `query()` loop from `@anthropic-ai/claude-agent-sdk` and translates
 * its output to the normalized event stream defined in server/harness/types.ts.
 *
 * This is the ONLY file outside server/harness/claude/ that may import from
 * `@anthropic-ai/claude-agent-sdk`. The architecture test added in Phase 2
 * enforces this boundary.
 *
 * Phase 1: ClaudeHarness exists alongside the existing session-host.ts loop.
 *   Neither session-host.ts nor any caller uses this class yet.
 *   It is exercised only by translate.test.ts and tools.test.ts.
 *
 * Phase 2: session-host.ts will switch over to this harness.
 *
 * See docs/model-agnosticism-spec.md §3.2 and Phase 1.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { registerHarness } from "../index.ts";

function resolveClaudePath(): string {
  if (process.env["CLAUDE_CODE_PATH"]) return process.env["CLAUDE_CODE_PATH"];
  try {
    return execSync("which claude", { encoding: "utf8" }).trim();
  } catch {
    return "claude";
  }
}

const CLAUDE_EXECUTABLE = resolveClaudePath();

import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessRunControl,
  HarnessStartOptions,
  HarnessStaticInfo,
  NormalizedEvent,
  NormalizedToolDef,
} from "../types.ts";
import { sdkToNormalized } from "./translate.ts";
import { wrapTools } from "./tools.ts";
import { resolveModelAlias, supportsAdaptiveThinking } from "./models.ts";

// ── Capability declaration ────────────────────────────────────────────────────

const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  thinking: true,
  promptCaching: true,
  mcp: true,
  permissionPrompts: true,
  resume: true,
  partialMessages: true,
  builtInFilesystem: true,
};

/**
 * Built-in tools the Claude Code binary exposes to the agent without any MCP
 * server. Phase 5: moved here from the `CODE_TOOLS` constant in
 * `server/session-host-run.ts` so that non-Claude harnesses can declare a
 * different (or empty) list.
 */
const CLAUDE_BUILT_IN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Agent",
  "WebFetch",
  "WebSearch",
] as const;

/**
 * Static model list for staticInfo(). Derived from MODEL_ALIAS_MAP in
 * models.ts — update both when new model IDs are released.
 */
const CLAUDE_STATIC_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-opus-4-7", label: "Opus" },
  { id: "claude-sonnet-4-6", label: "Sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku" },
];

// ── SDK handle type ───────────────────────────────────────────────────────────

/**
 * The Claude SDK `query()` return value is an AsyncIterable<SDKMessage> and
 * also exposes per-run control methods. We cast to this local interface so
 * TypeScript knows about them without leaking SDK types outside this file.
 * The double-cast (via unknown) is intentional — the SDK's opaque Query type
 * does not structurally overlap with this declared interface.
 */
interface SdkQueryHandle extends AsyncIterable<SDKMessage> {
  close?(): Promise<void>;
  interrupt?(): Promise<void>;
  setModel?(model: string): Promise<void>;
  setPermissionMode?(mode: never): Promise<void>;
  getContextUsage?(): Promise<unknown>;
  mcpServerStatus?(): Promise<unknown>;
  rewindFiles?(userMessageId: string, opts?: { dryRun?: boolean }): Promise<unknown>;
  seedReadState?(path: string, mtime: number): Promise<unknown>;
  stopTask?(taskId: string): Promise<unknown>;
  reconnectMcpServer?(serverName: string): Promise<unknown>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<unknown>;
}

// ── ClaudeHarness ─────────────────────────────────────────────────────────────

class ClaudeHarness implements AgentHarness {
  readonly name = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly builtInTools: string[] = [...CLAUDE_BUILT_IN_TOOLS];

  private registeredGroups: Record<string, NormalizedToolDef[]> = {};

  /**
   * Register tool definitions grouped by MCP server name.
   * Each key becomes a separate MCP server so tool call names remain
   * `mcp__<serverName>__<toolName>` as before.
   */
  registerTools(toolGroups: Record<string, NormalizedToolDef[]>): void {
    this.registeredGroups = toolGroups;
  }

  /**
   * Map a user-supplied alias to a concrete model ID.
   * Returns null for empty/null input; passes through unknown strings as-is.
   */
  resolveModel(alias: string): string | null {
    return resolveModelAlias(alias);
  }

  /** Static introspection — safe to call before, during, and after start(). */
  staticInfo(): HarnessStaticInfo {
    return {
      models: CLAUDE_STATIC_MODELS,
      commands: [],
      agents: [],
      account: { provider: "claude" },
    };
  }

  /**
   * Start the Claude session and return a normalized event stream plus a
   * per-run control surface.
   *
   * start() is synchronous — it constructs the AbortController and control
   * object immediately, then returns. The async generator opens the SDK
   * query() handle lazily on first iteration. This ensures the control's
   * abort() is safe to call before iteration begins.
   *
   * Emits `init` first and `done` last per the AgentHarness contract.
   */
  start(opts: HarnessStartOptions): { events: AsyncIterable<NormalizedEvent>; control: HarnessRunControl } {
    const abortController = new AbortController();
    // Wire the incoming signal into our local controller. Also handle the case
    // where the signal was already aborted before we registered the listener —
    // in that scenario the "abort" event has already fired and won't fire again.
    opts.abortSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    if (opts.abortSignal.aborted) abortController.abort();

    // Snapshot registered groups so the generator captures its own copy and
    // concurrent calls cannot step on each other.
    const registeredGroups = { ...this.registeredGroups };

    // Shared mutable reference populated when the generator starts iterating.
    // Control methods guard on null so they are safe to call at any time.
    let handle: SdkQueryHandle | null = null;

    async function* makeEvents(): AsyncGenerator<NormalizedEvent> {
      // Build MCP server map from registered groups.
      const mcpServers: Record<string, unknown> = {};
      for (const [serverName, defs] of Object.entries(registeredGroups)) {
        if (defs.length > 0) {
          mcpServers[serverName] = wrapTools(serverName, defs);
        }
      }

      const options: Record<string, unknown> = {
        cwd: opts.cwd,
        resume: opts.resumeId,
        allowedTools: opts.allowedTools,
        // permissionMode: Claude-specific permission model — gated by capabilities.
        permissionMode: "auto",
        abortController,
        includePartialMessages: true,
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        // Claude executable path — Claude-specific; other harnesses omit this.
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      };

      // Merge externally-supplied pre-wrapped MCP servers (e.g. from the project
      // sidecar's mcp-servers.json) alongside the tool-group servers.
      const allServers = { ...mcpServers, ...(opts.externalMcpServers ?? {}) };
      if (Object.keys(allServers).length > 0) {
        options["mcpServers"] = allServers;
      }

      if (opts.thinking && CLAUDE_CAPABILITIES.thinking && supportsAdaptiveThinking(opts.model)) {
        options["thinking"] = { type: "adaptive", display: opts.thinking.display };
        options["effort"] = opts.thinking.effort;
      }

      const prompt =
        typeof opts.prompt === "string" ? opts.prompt : collectPrompt(opts.prompt);

      // Open the SDK handle lazily on first iteration. The double-cast bypasses
      // the structural overlap check between the SDK's opaque Query type and our
      // local SdkQueryHandle interface.
      handle = query({
        prompt: typeof prompt === "string" ? prompt : (prompt as never),
        options: options as never,
      }) as unknown as SdkQueryHandle;

      try {
        for await (const msg of handle) {
          if (abortController.signal.aborted) break;

          // Intercept Claude Agent-tool sub-agent system events before the
          // generic translator so they become NormalizedEvent variants.
          const raw = msg as { type?: string; subtype?: string } & Record<string, unknown>;
          if (raw.type === "system") {
            if (raw.subtype === "task_started") {
              yield {
                kind: "agent_spawned",
                taskId: (raw["task_id"] as string) ?? `agent-${Date.now().toString(36)}`,
                description: (raw["description"] as string) ?? "Subagent task",
              };
              continue;
            }
            if (raw.subtype === "task_notification") {
              yield {
                kind: "agent_task_update",
                taskId: (raw["task_id"] as string) ?? "",
                status: (raw["status"] as string) ?? "completed",
                summary: (raw["summary"] as string) ?? "",
              };
              continue;
            }
            // system/init: attach raw Claude meta so the host can populate initData.
            if (raw.subtype === "init") {
              const normalized = sdkToNormalized(msg);
              for (const evt of normalized) {
                if (evt.kind === "init") {
                  yield {
                    ...evt,
                    meta: {
                      tools: raw["tools"],
                      model: raw["model"],
                      mcp_servers: raw["mcp_servers"],
                      permissionMode: raw["permissionMode"],
                      slash_commands: raw["slash_commands"],
                      skills: raw["skills"],
                      claude_code_version: raw["claude_code_version"],
                    },
                  };
                } else {
                  yield evt;
                }
              }
              continue;
            }
          }

          const events = sdkToNormalized(msg);
          for (const evt of events) {
            yield evt;
          }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        yield { kind: "done", reason: "error", error };
        return;
      }

      // Ensure `done` is always emitted, even when the loop exits cleanly
      // without a result message (e.g. abort before result arrives).
      if (abortController.signal.aborted) {
        yield { kind: "done", reason: "abort" };
      }
    }

    const control: HarnessRunControl = {
      abort(): void {
        abortController.abort();
      },
      close: () => handle?.close?.() ?? Promise.resolve(),
      interrupt: () => handle?.interrupt?.() ?? Promise.resolve(),
      setModel: (model: string) => handle?.setModel?.(model) ?? Promise.resolve(),
      setPermissionMode: (mode: string) =>
        handle?.setPermissionMode?.(mode as never) ?? Promise.resolve(),
      getContextUsage: () => handle?.getContextUsage?.() ?? Promise.resolve(undefined),
      mcpServerStatus: () => handle?.mcpServerStatus?.() ?? Promise.resolve(undefined),
      rewindFiles: (args) =>
        handle?.rewindFiles?.(
          args.userMessageId,
          args.dryRun !== undefined ? { dryRun: args.dryRun } : undefined,
        ) ?? Promise.resolve(undefined),
      seedReadState: (args) =>
        handle?.seedReadState?.(args.path, args.mtime) ?? Promise.resolve(undefined),
      stopTask: (taskId: string) =>
        handle?.stopTask?.(taskId) ?? Promise.resolve(undefined),
      reconnectMcpServer: (serverName: string) =>
        handle?.reconnectMcpServer?.(serverName) ?? Promise.resolve(undefined),
      toggleMcpServer: (serverName: string, enabled: boolean) =>
        handle?.toggleMcpServer?.(serverName, enabled) ?? Promise.resolve(undefined),
    };

    return { events: makeEvents(), control };
  }
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

/** Collect an async-iterable of user messages into a single string. */
async function collectPrompt(
  iter: AsyncIterable<{ role: "user"; content: string }>,
): Promise<string> {
  const parts: string[] = [];
  for await (const msg of iter) {
    parts.push(msg.content);
  }
  return parts.join("\n");
}

// ── Self-registration ─────────────────────────────────────────────────────────

/**
 * Register the Claude harness on import (side-effect import pattern).
 * Callers import this module and can then call getHarness("claude").
 */
export const claudeHarness = new ClaudeHarness();
registerHarness(claudeHarness);
