/**
 * ClaudeHarness — AgentHarness implementation for the Anthropic Claude SDK.
 *
 * Wraps the `query()` loop from `@anthropic-ai/claude-agent-sdk` and translates
 * its output to the normalized event stream defined in server/harness/types.ts.
 *
 * This is the registered Claude implementation used by SessionHost. Imports
 * of `@anthropic-ai/claude-agent-sdk` stay inside this harness subtree; an
 * architecture test enforces that boundary.
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { registerHarness } from "../index.ts";

function compareNames(a: string, b: string): number {
  return a.localeCompare(b);
}

function sortedToolDefs(defs: NormalizedToolDef[]): NormalizedToolDef[] {
  return [...defs].sort((a, b) => compareNames(a.name, b.name));
}

function sortedRecordEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([a], [b]) => compareNames(a, b));
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(sortedRecordEntries(record));
}

import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessRunControl,
  HarnessStartOptions,
  HarnessStaticInfo,
  NormalizedEvent,
  NormalizedToolDef,
} from "../types.ts";
import { isClaudeToolUseDiagnostic, sdkToNormalized } from "./translate.ts";
import { wrapTools } from "./tools.ts";
import { resolveModelAlias, supportsAdaptiveThinking } from "./models.ts";
import { buildClaudePrompt } from "./prompt.ts";
import { checkClaudeReadiness, resolveClaudeRuntime } from "./runtime.ts";
import { createClaudeMutationHooks } from "./mutation-hooks.ts";
import {
  HARNESS_DRAIN,
  persistAbortedHarnessTerminal,
  tagTerminalProvenance,
  trackHarnessDrain,
  type DrainableHarnessControl,
} from "../terminal-provenance.ts";

const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  mutationInterception: "complete",
  thinking: true,
  promptCaching: true,
  mcp: true,
  permissionPrompts: true,
  resume: true,
  partialMessages: true,
  builtInFilesystem: true,
  sandboxEnforcement: {
    // Claude still consumes its legacy permissionMode below. It does not
    // expose independent filesystem/network/approval controls matching the
    // provider-neutral policy, so do not claim those guarantees here.
    filesystem: [],
    network: false,
    approval: false,
  },
};

/**
 * Built-in tools the Claude Code binary exposes to the agent without any MCP
 * server. Harness-local ownership lets other harnesses declare a different
 * (or empty) list.
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
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Haiku" },
];

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
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<unknown>;
  mcpServerStatus?(): Promise<unknown>;
  rewindFiles?(userMessageId: string, opts?: { dryRun?: boolean }): Promise<unknown>;
  seedReadState?(path: string, mtime: number): Promise<unknown>;
  stopTask?(taskId: string): Promise<unknown>;
  reconnectMcpServer?(serverName: string): Promise<unknown>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<unknown>;
}

class ClaudeHarness implements AgentHarness {
  readonly name = "claude";
  readonly exposure = "production" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly builtInTools: string[] = [...CLAUDE_BUILT_IN_TOOLS];

  checkReadiness = checkClaudeReadiness;

  private registeredGroups: Record<string, NormalizedToolDef[]> = {};

  /**
   * Register tool definitions grouped by MCP server name.
   * Each key becomes a separate MCP server so tool call names remain
   * `mcp__<serverName>__<toolName>` as before.
   */
  registerTools(toolGroups: Record<string, NormalizedToolDef[]>): void {
    this.registeredGroups = Object.fromEntries(
      sortedRecordEntries(toolGroups).map(([serverName, defs]) => [
        serverName,
        sortedToolDefs(defs),
      ]),
    );
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
    opts.mutationCoordination?.setLeaseLostHandler(() => abortController.abort());

    // Snapshot registered groups so the generator captures its own copy and
    // concurrent calls cannot step on each other.
    const registeredGroups = Object.fromEntries(
      sortedRecordEntries(this.registeredGroups).map(([serverName, defs]) => [
        serverName,
        [...defs],
      ]),
    );

    // Populated when the generator starts; controls remain safe before then.
    let handle: SdkQueryHandle | null = null;

    async function* makeEvents(): AsyncGenerator<NormalizedEvent> {
      const mcpServers: Record<string, unknown> = {};
      for (const [serverName, defs] of sortedRecordEntries(registeredGroups)) {
        if (defs.length > 0) {
          mcpServers[serverName] = wrapTools(serverName, defs);
        }
      }

      const options: Record<string, unknown> = {
        cwd: opts.cwd,
        resume: opts.resumeId,
        allowedTools: [...opts.allowedTools].sort(compareNames),
        // permissionMode: Claude consumes the normalized mode verbatim.
        permissionMode: opts.permissionMode ?? "auto",
        abortController,
        includePartialMessages: true,
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        strictMcpConfig: true,
      };

      // Claude executable path override. When unset, let the SDK use its own
      // platform-aware bundled/default discovery instead of repo-side probing.
      const claudeRuntime = resolveClaudeRuntime();
      if (!claudeRuntime) throw new Error("Claude runtime is unavailable. Reinstall dependencies or set CLAUDE_CODE_PATH.");
      options["pathToClaudeCodeExecutable"] = claudeRuntime.executable;

      // Merge externally-supplied pre-wrapped MCP servers (e.g. from the project
      // sidecar's mcp-servers.json) alongside the tool-group servers.
      const allServers = sortedRecord({ ...mcpServers, ...(opts.externalMcpServers ?? {}) });
      if (Object.keys(allServers).length > 0) {
        options["mcpServers"] = allServers;
      }

      if (opts.thinking && CLAUDE_CAPABILITIES.thinking && supportsAdaptiveThinking(opts.model)) {
        options["thinking"] = { type: "adaptive", display: opts.thinking.display };
        options["effort"] = opts.thinking.effort;
      }
      if (opts.mutationCoordination) {
        const readOnlyTools = new Set(sortedRecordEntries(registeredGroups).flatMap(
          ([serverName, defs]) => defs.filter((def) => def.annotations?.readOnlyHint === true)
            .map((def) => `mcp__${serverName}__${def.name}`)));
        options["hooks"] = createClaudeMutationHooks(opts.mutationCoordination, readOnlyTools);
      }

      const sdkPrompt = await buildClaudePrompt(opts);

      try {
        // Open the SDK handle lazily on first iteration. The double-cast
        // bypasses the structural overlap check between the SDK's opaque
        // Query type and our local SdkQueryHandle interface. Keep this
        // inside the try so a synchronous SDK setup failure is reported
        // as a normalized done(error) instead of bubbling out of the
        // generator.
        handle = query({
          prompt: typeof sdkPrompt === "string" ? sdkPrompt : (sdkPrompt as never),
          options: options as never,
        }) as unknown as SdkQueryHandle;

        for await (const msg of handle) {
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
          if (abortController.signal.aborted) {
            for (const evt of events) {
              if (evt.kind === "done") {
                persistAbortedHarnessTerminal(opts.sessionKey, evt);
              }
            }
            continue;
          }
          for (const evt of events) {
            yield evt;
          }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        if (isClaudeToolUseDiagnostic(error)) {
          const done = tagTerminalProvenance(
            { kind: "done", reason: "completed" },
            "adapter",
          );
          if (abortController.signal.aborted) {
            persistAbortedHarnessTerminal(opts.sessionKey, done);
          }
          yield done;
          return;
        }
        const done = tagTerminalProvenance(
          { kind: "done", reason: "error", error },
          "adapter",
        );
        if (abortController.signal.aborted) {
          persistAbortedHarnessTerminal(opts.sessionKey, done);
        }
        yield done;
        return;
      } finally {
        opts.mutationCoordination?.disconnect();
      }

      // Ensure `done` is always emitted, even when the loop exits cleanly
      // without a result message (e.g. abort before result arrives).
      if (abortController.signal.aborted) {
        const done = tagTerminalProvenance(
          { kind: "done", reason: "abort" },
          "adapter",
        );
        persistAbortedHarnessTerminal(opts.sessionKey, done);
        yield done;
      }
    }

    const tracked = trackHarnessDrain(makeEvents());
    const control: DrainableHarnessControl = {
      abort(): void {
        // Signal the SDK first. The generator's `finally` releases mutation
        // leases only after the SDK stream has actually unwound, preventing a
        // queued writer from starting while the aborted tool is still stopping.
        abortController.abort();
      },
      close: () => handle?.close?.() ?? Promise.resolve(),
      interrupt: () => handle?.interrupt?.() ?? Promise.resolve(),
      setModel: (model: string) => handle?.setModel?.(model) ?? Promise.resolve(),
      setPermissionMode: (mode: string) =>
        handle?.setPermissionMode?.(mode as never) ?? Promise.resolve(),
      getContextUsage: () => handle?.getContextUsage?.() ?? Promise.resolve(undefined),
      getUsageReport: () =>
        handle?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.() ??
        Promise.resolve(undefined),
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
      [HARNESS_DRAIN]: tracked.drain,
    };
    return { events: tracked.events, control };
  }
}

/**
 * Register the Claude harness on import (side-effect import pattern).
 * Callers import this module and can then call getHarness("claude").
 */
export const claudeHarness = new ClaudeHarness();
registerHarness(claudeHarness);
