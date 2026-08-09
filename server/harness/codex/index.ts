/**
 * CodexHarness — AgentHarness implementation for OpenAI's Codex SDK.
 *
 * Wraps the `Codex` / `Thread.runStreamed` loop from `@openai/codex-sdk` and
 * translates its event stream to the normalized event format defined in
 * `shared/normalized-event.ts`.
 *
 * Tools reach Codex through the streamable-HTTP MCP bridge (see
 * `server/mcp-bridge/`) — not in-process, the way Claude consumes them.
 * The bridge URL + bearer token are passed to the Codex CLI through
 * `--config` overrides rendered by `./mcp-config.ts`; tokens never appear
 * in the argv (they're injected via env-vars Codex reads at startup).
 *
 * Image attachments are written to a per-session scratch directory under
 * `os.tmpdir()/minions-codex-attachments/<sessionKey>/` and passed as
 * `local_image` UserInput entries.
 */

import { Codex } from "@openai/codex-sdk";
import type {
  CodexOptions,
  Input,
  ThreadEvent,
  ThreadOptions,
  Thread,
  UserInput,
} from "@openai/codex-sdk";

import { registerHarness } from "../index.ts";
import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessRunControl,
  HarnessStartOptions,
  HarnessStaticInfo,
  NormalizedEvent,
  NormalizedToolDef,
} from "../types.ts";

import { getBridgeServer } from "../../mcp-bridge/server.ts";
import type { McpBridgeRegistration } from "../../mcp-bridge/registry.ts";

import { createCodexTranslator } from "./translate.ts";
import { resolveCodexCredentials } from "./auth.ts";
import {
  buildCodexConfig,
  mapPermission,
  mapReasoningEffort,
} from "./options.ts";
import { CODEX_STATIC_MODELS, resolveCodexModel } from "./models.ts";
import {
  buildCodexInput,
  writeCodexAttachments,
  type CodexAttachmentScratch,
} from "./attachments.ts";
import { buildCodexEnv } from "./env.ts";
import { renderBridgeServers, type CodexConfigObject } from "./mcp-config.ts";
import { checkCodexReadiness, resolveCodexRuntime } from "./runtime.ts";
import { tagTerminalProvenance } from "../terminal-provenance.ts";

const CODEX_CAPABILITIES: HarnessCapabilities = {
  mutationInterception: "observe_only",
  thinking: true,
  promptCaching: true,
  mcp: true,
  permissionPrompts: true,
  resume: true,
  // Codex's SDK emits item-level updates, not text deltas; we don't surface
  // partials yet.
  partialMessages: false,
  // Codex ships built-in shell + filesystem capabilities through its CLI.
  builtInFilesystem: true,
};

const CODEX_BUILT_IN_TOOLS: ReadonlyArray<string> = [];

class CodexHarness implements AgentHarness {
  readonly name = "codex";
  readonly exposure = "production" as const;
  readonly capabilities = CODEX_CAPABILITIES;
  readonly builtInTools: string[] = [...CODEX_BUILT_IN_TOOLS];

  checkReadiness = checkCodexReadiness;

  private registeredGroups: Record<string, NormalizedToolDef[]> = {};

  registerTools(toolGroups: Record<string, NormalizedToolDef[]>): void {
    this.registeredGroups = toolGroups;
  }

  resolveModel(alias: string): string | null {
    return resolveCodexModel(alias);
  }

  staticInfo(): HarnessStaticInfo {
    return {
      models: CODEX_STATIC_MODELS,
      commands: [],
      agents: [],
      account: { provider: "openai" },
    };
  }

  async getUsageReport(): Promise<unknown> {
    const creds = resolveCodexCredentials();
    const authenticated = Boolean(creds.apiKey);
    return {
      provider: "openai",
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      unavailable_reason:
        "OpenAI/Codex rate-limit reset windows are not exposed by the installed Codex SDK or CLI.",
      auth: {
        authenticated,
        source: creds.apiKey ? "api_key" : "unknown",
      },
    };
  }

  /**
   * Start a Codex session. Returns the event stream the host pulls until the
   * `done` event is emitted, plus a per-run control surface command handlers
   * route through.
   *
   * Construction is synchronous — the AbortController and control object are
   * created before returning so `control.abort()` is safe to call before the
   * generator is iterated. The async work (bridge registration, attachment
   * scratch, Codex thread setup) happens lazily inside the generator.
   */
  start(opts: HarnessStartOptions): {
    events: AsyncIterable<NormalizedEvent>;
    control: HarnessRunControl;
  } {
    const ac = new AbortController();
    opts.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
    if (opts.abortSignal.aborted) ac.abort();

    // Snapshot registered groups so concurrent runs don't step on each other.
    const registeredGroups = { ...this.registeredGroups };

    const events = (async function* makeEvents(): AsyncGenerator<NormalizedEvent> {
      let bridgeReg: McpBridgeRegistration | null = null;
      let scratch: CodexAttachmentScratch | null = null;
      try {
        if (Object.keys(opts.externalMcpServers ?? {}).length > 0) {
          yield tagTerminalProvenance({
            kind: "done",
            reason: "error",
            error:
              "External project MCP servers are not supported by harness \"codex\" yet. " +
              "Use the Claude harness or remove the external MCP configuration.",
          }, "adapter");
          return;
        }

        // Fail fast when Codex has no credentials. Without this preflight
        // the CLI spawn fails or hangs while emitting zero events, and the
        // session sits silent at 0 turns until a task timeout aborts it
        // (observed: every minion spawn dying with "Session abort.").
        const runtime = resolveCodexRuntime();
        if (!runtime) {
          yield tagTerminalProvenance({ kind: "done", reason: "error",
            error: "Codex runtime is unavailable. Reinstall dependencies or set CODEX_PATH." }, "adapter");
          return;
        }
        const creds = resolveCodexCredentials();

        // Materialize image attachments to disk if any.
        if (opts.attachments && opts.attachments.length > 0) {
          scratch = await writeCodexAttachments({
            sessionKey: opts.sessionKey,
            attachments: opts.attachments,
          });
        }

        // Register the session's tool groups with the MCP bridge so Codex can
        // call them over loopback HTTP.
        const groupNames = Object.keys(registeredGroups).filter(
          (g) => (registeredGroups[g]?.length ?? 0) > 0,
        );
        let bridgeConfig: CodexConfigObject = {};
        let bridgeEnv: Record<string, string> = {};
        if (groupNames.length > 0) {
          const bridgeServer = await getBridgeServer();
          bridgeReg = bridgeServer.register({
            sessionKey: opts.sessionKey,
            groups: registeredGroups,
          });
          const rendered = renderBridgeServers(bridgeReg, groupNames);
          bridgeConfig = rendered.config;
          bridgeEnv = rendered.env;
        }

        const codexOpts: CodexOptions = { ...creds, codexPathOverride: runtime.executable };
        const env = buildCodexEnv(bridgeEnv, opts.cwd);
        if (env) codexOpts.env = env;
        const codexConfig = buildCodexConfig(bridgeConfig, opts.systemPrompt);
        if (Object.keys(codexConfig).length > 0) {
          // Local CodexConfigObject is Record<string, unknown>; values produced
          // here are JSON-serializable so the SDK's stricter CodexConfigValue
          // typing is satisfied at runtime.
          codexOpts.config = codexConfig as CodexOptions["config"];
        }
        const codex = new Codex(codexOpts);

        const threadOpts = buildThreadOptions(opts);
        const thread: Thread = opts.resumeId
          ? codex.resumeThread(opts.resumeId, threadOpts)
          : codex.startThread(threadOpts);

        const text =
          typeof opts.prompt === "string"
            ? opts.prompt
            : await collectPrompt(opts.prompt);
        const input: Input = buildCodexInput(text, scratch);

        const translator = createCodexTranslator({ model: opts.model });
        const streamErrors: string[] = [];

        let runResult;
        try {
          runResult = await thread.runStreamed(input, { signal: ac.signal });
        } catch (err) {
          // SDK rejection after abort is bookkeeping noise from the abort
          // path itself — surface as `abort`, not `error`, so command
          // handlers don't show a phantom failure message.
          if (ac.signal.aborted) {
            yield tagTerminalProvenance({ kind: "done", reason: "abort" }, "adapter");
            return;
          }
          if (isBenignWindowsTaskkillParseError(errorMessage(err))) {
            yield tagTerminalProvenance({ kind: "done", reason: "stop" }, "adapter");
            return;
          }
          yield codexDoneError(errorMessage(err), streamErrors);
          return;
        }

        // Track explicit and implicit completion evidence so the outer
        // generator can synthesize exactly one truthful terminal event.
        let terminalEmitted = false;
        let turnCompleted = false;
        try {
          for await (const evt of runResult.events as AsyncIterable<ThreadEvent>) {
            if (ac.signal.aborted) break;
            if (evt.type === "turn.completed") turnCompleted = true;
            if (evt.type === "error") streamErrors.push(evt.message);
            const normalized = translator.translate(evt).map((e) => e.kind === "done"
              ? tagTerminalProvenance(e.reason === "error" ? { ...e,
                fullError: fullCodexError(e.error ?? "unknown", streamErrors) } : e, "adapter")
              : e);
            for (const e of normalized) {
              if (e.kind === "done") terminalEmitted = true;
              yield e;
            }
          }
        } catch (err) {
          // Same reasoning as the runStreamed catch above: an abort that
          // cancels in-flight `await for` iteration commonly bubbles as a
          // rejection. Treat it as an abort, not an error.
          if (ac.signal.aborted) {
            yield tagTerminalProvenance({ kind: "done", reason: "abort" }, "adapter");
            return;
          }
          if (isBenignWindowsTaskkillParseError(errorMessage(err))) {
            if (!terminalEmitted) {
              yield tagTerminalProvenance({
                kind: "done",
                reason: turnCompleted ? "completed" : "stop",
              }, "adapter");
            }
            return;
          }
          yield codexDoneError(errorMessage(err), streamErrors);
          return;
        }

        if (terminalEmitted) return;
        yield tagTerminalProvenance(ac.signal.aborted
          ? { kind: "done", reason: "abort" }
          : { kind: "done", reason: turnCompleted ? "completed" : "stop" }, "adapter");
      } finally {
        bridgeReg?.dispose();
        if (scratch !== null) {
          try {
            await scratch.dispose();
          } catch {
            // Cleanup failures are non-fatal — the OS will reclaim tmpdir.
          }
        }
      }
    })();

    const control: HarnessRunControl = {
      abort(): void {
        ac.abort();
      },
      close: async (): Promise<void> => {
        ac.abort();
      },
    };

    return { events, control };
  }
}

/**
 * Build the ThreadOptions consumed by Codex.startThread / resumeThread.
 * Maps Minions normalized options onto Codex's native shape.
 */
function buildThreadOptions(opts: HarnessStartOptions): ThreadOptions {
  const out: ThreadOptions = {
    workingDirectory: opts.cwd,
    skipGitRepoCheck: true,
  };
  if (opts.model) out.model = opts.model;

  const perm = mapPermission(opts.permissionMode);
  out.approvalPolicy = perm.approvalPolicy;
  out.sandboxMode = perm.sandboxMode;

  if (opts.thinking && CODEX_CAPABILITIES.thinking) {
    out.modelReasoningEffort = mapReasoningEffort(opts.thinking.effort);
  }

  return out;
}

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBenignWindowsTaskkillParseError(message: string): boolean {
  return /^Failed to parse item:\s*SUCCESS:\s+The process with PID \d+(?: \(child process of PID \d+\))? has been terminated\.\s*$/i.test(
    message.trim(),
  );
}

function codexDoneError(
  message: string,
  streamErrors: readonly string[],
): NormalizedEvent {
  return tagTerminalProvenance({
    kind: "done",
    reason: "error",
    error: message,
    fullError: fullCodexError(message, streamErrors),
  }, "adapter");
}

function fullCodexError(message: string, streamErrors: readonly string[]): string {
  if (streamErrors.length === 0) return message;
  return [
    message,
    "",
    "Codex stream errors before termination:",
    ...streamErrors.map((m, i) => `${i + 1}. ${m}`),
  ].join("\n");
}

// Re-export internal helpers for tests; production callers use start().
export { buildThreadOptions, resolveCodexCredentials };

export const codexHarness = new CodexHarness();
registerHarness(codexHarness);

// `UserInput` is re-used in tests that want to construct fake inputs without
// taking a direct dependency on the SDK.
export type { UserInput };
