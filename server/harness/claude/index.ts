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
import { registerHarness } from "../index.ts";

// ── Phase 2 transitional exports ──────────────────────────────────────────────

/**
 * Duck-typed subset of the SDK's Query interface.
 *
 * Exposes only the methods that session-host.ts and its command handlers
 * actually call. Defining this here — rather than importing `Query` from
 * the SDK — keeps @anthropic-ai/claude-agent-sdk isolated inside
 * server/harness/claude/ as required by the architecture test added in
 * Phase 2.
 *
 * TODO(phase3): delete when session-host.ts switches to harness.start()
 * and the query handle is no longer exposed directly.
 */
export interface QueryHandleLike extends AsyncIterable<unknown> {
  close(): Promise<void>;
  interrupt(): Promise<void>;
  getContextUsage(): Promise<unknown>;
  supportedModels(): Promise<unknown>;
  supportedCommands(): Promise<unknown>;
  supportedAgents(): Promise<unknown>;
  accountInfo(): Promise<unknown>;
  mcpServerStatus(): Promise<unknown>;
}

/**
 * Wrap the SDK's `query()` call so session-host.ts can open a query loop
 * without importing @anthropic-ai/claude-agent-sdk directly.
 *
 * The `prompt` parameter accepts `string | AsyncIterable<…>` (whatever
 * `buildQueryPrompt` returns) typed as `unknown` so session-host.ts need
 * not import any SDK type to pass it in.
 *
 * TODO(phase3): delete when session-host.ts is fully switched to harness.start().
 */
export function runClaudeQuery(
  prompt: unknown,
  options: Record<string, unknown>,
): QueryHandleLike {
  return query({
    prompt: prompt as never,
    options: options as never,
  }) as unknown as QueryHandleLike;
}
import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessStartOptions,
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
};

// ── ClaudeHarness ─────────────────────────────────────────────────────────────

class ClaudeHarness implements AgentHarness {
  readonly name = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private abortController: AbortController | null = null;
  private registeredDefs: NormalizedToolDef[] = [];

  /** Register tool definitions. Called before start(). */
  registerTools(defs: NormalizedToolDef[]): void {
    this.registeredDefs = defs;
  }

  /**
   * Map a user-supplied alias to a concrete model ID.
   * Returns null for empty/null input; passes through unknown strings as-is.
   */
  resolveModel(alias: string): string | null {
    return resolveModelAlias(alias);
  }

  /** Abort the running session. Idempotent. */
  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Start the Claude session and yield normalized events until done.
   *
   * Emits `init` first and `done` last per the AgentHarness contract.
   * The caller (session-host.ts in Phase 2) drives this iterator.
   */
  async *start(opts: HarnessStartOptions): AsyncIterable<NormalizedEvent> {
    const abortController = new AbortController();
    this.abortController = abortController;

    // Wire the caller's AbortSignal into our controller.
    opts.abortSignal.addEventListener("abort", () => abortController.abort(), { once: true });

    const mcpServers: Record<string, unknown> = {};
    if (this.registeredDefs.length > 0) {
      const server = wrapTools("minions-tools", this.registeredDefs);
      mcpServers["minions-tools"] = server;
    }

    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      resume: opts.resumeId,
      allowedTools: opts.allowedTools,
      permissionMode: "auto",
      abortController,
      includePartialMessages: true,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
    };

    if (Object.keys(mcpServers).length > 0) {
      options["mcpServers"] = mcpServers;
    }

    if (opts.thinking && supportsAdaptiveThinking(opts.model)) {
      options["thinking"] = { type: "adaptive", display: opts.thinking.display };
      options["effort"] = opts.thinking.effort;
    }

    const prompt =
      typeof opts.prompt === "string" ? opts.prompt : collectPrompt(opts.prompt);

    try {
      const handle = query({
        prompt: typeof prompt === "string" ? prompt : (prompt as never),
        options: options as never,
      });

      for await (const msg of handle) {
        if (abortController.signal.aborted) break;
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
