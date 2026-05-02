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

// ── ClaudeHarness ─────────────────────────────────────────────────────────────

class ClaudeHarness implements AgentHarness {
  readonly name = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly builtInTools: string[] = [...CLAUDE_BUILT_IN_TOOLS];

  private abortController: AbortController | null = null;
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

    // Wrap each registered group as a separate named MCP server so tool call
    // names follow the `mcp__<serverName>__<toolName>` pattern.
    const mcpServers: Record<string, unknown> = {};
    for (const [serverName, defs] of Object.entries(this.registeredGroups)) {
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

    if (opts.thinking && this.capabilities.thinking && supportsAdaptiveThinking(opts.model)) {
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
