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
 *
 * See docs/codex-harness-spec.md §"Codex Harness" and §"Codex MCP Bridge"
 * for the design rationale.
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
import { mapPermission, mapReasoningEffort } from "./options.ts";
import { CODEX_STATIC_MODELS, resolveCodexModel } from "./models.ts";
import {
  buildCodexInput,
  writeCodexAttachments,
  type CodexAttachmentScratch,
} from "./attachments.ts";
import { renderBridgeServers, type CodexConfigObject } from "./mcp-config.ts";

// ── Capability declaration ────────────────────────────────────────────────────

const CODEX_CAPABILITIES: HarnessCapabilities = {
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

// ── CodexHarness ──────────────────────────────────────────────────────────────

class CodexHarness implements AgentHarness {
  readonly name = "codex";
  readonly capabilities = CODEX_CAPABILITIES;
  readonly builtInTools: string[] = [...CODEX_BUILT_IN_TOOLS];

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
        // Reject permission modes Codex cannot honor before any I/O. `plan`
        // is unsupported for MVP per docs/codex-harness-spec.md Open Questions
        // §5; surface a clean terminal error instead of silently mapping it to
        // a half-correct approvalPolicy/sandboxMode pair. UI gating for `plan`
        // on Codex sessions lands in Phase E.
        const permissionMapping = mapPermission(opts.permissionMode);
        if (permissionMapping.unsupported) {
          yield {
            kind: "done",
            reason: "error",
            error:
              `Permission mode "${opts.permissionMode ?? "default"}" is not ` +
              `supported by harness "codex".`,
          };
          return;
        }

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

        // External user-configured MCP servers (`opts.externalMcpServers`) are
        // intentionally NOT rendered here. Phase D wires Minions-internal tool
        // groups through the bridge only; external MCP renderers per-harness
        // (Codex stdio + streamable HTTP shape) are deferred to a follow-up
        // because the source representation in `server/routines/external-mcp.ts`
        // is still Claude SDK-shaped. See docs/codex-harness-spec.md §"External
        // MCP" — silently passing the Claude config object into Codex would
        // either be dropped by the SDK or render incorrectly, so we drop it on
        // the floor here until the normalization lands. Capabilities and
        // staticInfo do not advertise external MCP support.
        const codexOpts: CodexOptions = {
          ...resolveCodexCredentials(),
        };
        if (Object.keys(bridgeEnv).length > 0) {
          codexOpts.env = { ...process.env, ...bridgeEnv } as Record<string, string>;
        }
        if (Object.keys(bridgeConfig).length > 0) {
          // Local CodexConfigObject is Record<string, unknown>; values produced
          // by renderBridgeServers are JSON-serializable so the SDK's stricter
          // CodexConfigValue typing is satisfied at runtime.
          codexOpts.config = bridgeConfig as CodexOptions["config"];
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

        let runResult;
        try {
          runResult = await thread.runStreamed(input, { signal: ac.signal });
        } catch (err) {
          // SDK rejection after abort is bookkeeping noise from the abort
          // path itself — surface as `abort`, not `error`, so command
          // handlers don't show a phantom failure message.
          if (ac.signal.aborted) {
            yield { kind: "done", reason: "abort" };
            return;
          }
          yield { kind: "done", reason: "error", error: errorMessage(err) };
          return;
        }

        // Track whether the SDK stream emitted a terminal `done`; the outer
        // generator emits one if the stream ended cleanly without one.
        let terminalEmitted = false;
        try {
          for await (const evt of runResult.events as AsyncIterable<ThreadEvent>) {
            if (ac.signal.aborted) break;
            const normalized = translator.translate(evt);
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
            yield { kind: "done", reason: "abort" };
            return;
          }
          yield { kind: "done", reason: "error", error: errorMessage(err) };
          return;
        }

        if (terminalEmitted) return;
        yield ac.signal.aborted
          ? { kind: "done", reason: "abort" }
          : { kind: "done", reason: "stop" };
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Pick up Codex API credentials from the environment without forcing them
 * into argv. Either `CODEX_API_KEY` or `OPENAI_API_KEY` is accepted; if
 * neither is set the SDK falls back to whatever the local `codex` CLI has
 * configured. `CODEX_PATH` overrides the discovered binary.
 */
function resolveCodexCredentials(): {
  apiKey?: string;
  codexPathOverride?: string;
} {
  const out: { apiKey?: string; codexPathOverride?: string } = {};
  const apiKey = process.env["CODEX_API_KEY"] ?? process.env["OPENAI_API_KEY"];
  if (apiKey) out.apiKey = apiKey;
  const codexPath = process.env["CODEX_PATH"];
  if (codexPath) out.codexPathOverride = codexPath;
  return out;
}

/**
 * Build the ThreadOptions consumed by Codex.startThread / resumeThread.
 * Maps Minions normalized options onto Codex's native shape.
 */
function buildThreadOptions(opts: HarnessStartOptions): ThreadOptions {
  const out: ThreadOptions = { workingDirectory: opts.cwd };
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

// Re-export internal helpers for tests; production callers use start().
export { buildThreadOptions, resolveCodexCredentials };

// ── Self-registration ─────────────────────────────────────────────────────────

export const codexHarness = new CodexHarness();
registerHarness(codexHarness);

// `UserInput` is re-used in tests that want to construct fake inputs without
// taking a direct dependency on the SDK.
export type { UserInput };
