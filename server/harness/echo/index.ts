/**
 * EchoHarness — a minimal second AgentHarness implementation.
 *
 * Purpose:
 *   1. Proves the AgentHarness seam is correctly abstracted — adding this
 *      harness required touching only this directory and the registry.
 *   2. Provides a fast, zero-network test fixture for unit tests that need
 *      a real `AgentHarness` without spinning up the Claude SDK.
 *
 * Behaviour:
 *   - `start()` yields `init`, then an `assistant` text block containing
 *     the prompt (the "echo"), then `done`.
 *   - All capabilities are `false` — this harness has no thinking, no
 *     prompt caching, no MCP, etc.
 *   - `builtInTools` is empty — the harness exposes no built-in file tools.
 *   - `resolveModel` returns the alias unchanged (any string is accepted).
 */

import { registerHarness } from "../index.ts";
import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessRunControl,
  HarnessStartOptions,
  HarnessStaticInfo,
  NormalizedToolDef,
} from "../types.ts";
import type { NormalizedEvent } from "../../../shared/normalized-event.ts";

const ECHO_CAPABILITIES: HarnessCapabilities = {
  mutationInterception: "none",
  thinking: false,
  promptCaching: false,
  mcp: false,
  permissionPrompts: false,
  resume: false,
  partialMessages: false,
  builtInFilesystem: false,
  sandboxEnforcement: { filesystem: [], approval: false },
};

class EchoHarness implements AgentHarness {
  readonly name = "echo";
  readonly exposure = "test" as const;
  readonly capabilities = ECHO_CAPABILITIES;
  readonly builtInTools: string[] = [];

  async checkReadiness() {
    return {
      state: "ready" as const,
      runtime: { available: true, source: "sdk_bundled" as const },
      auth: { authenticated: true, source: "unknown" as const },
    };
  }

  private registeredDefs: NormalizedToolDef[] = [];

  registerTools(toolGroups: Record<string, NormalizedToolDef[]>): void {
    // EchoHarness has no tool execution; store for completeness only.
    this.registeredDefs = Object.values(toolGroups).flat();
  }

  /**
   * Any string is accepted as a valid model id — the echo harness does not
   * distinguish models. Returns `null` for empty/null input.
   */
  resolveModel(alias: string): string | null {
    return alias || null;
  }

  /** Static introspection — safe to call before, during, and after start(). */
  staticInfo(): HarnessStaticInfo {
    return {
      models: [{ id: "echo", label: "Echo" }],
      commands: [],
      agents: [],
      account: { provider: "echo" },
    };
  }

  /**
   * Start the echo session. Returns the event stream plus a per-run control
   * surface. start() is synchronous — the AbortController is created before
   * returning so abort() is safe to call immediately.
   *
   * Yields `init`, then an assistant `text` event containing the prompt text,
   * then `done`. If the AbortSignal fires before the text event, the session
   * ends with `reason: "abort"`.
   */
  start(opts: HarnessStartOptions): { events: AsyncIterable<NormalizedEvent>; control: HarnessRunControl } {
    const ac = new AbortController();
    // Wire the incoming signal into our local controller. Also handle the case
    // where the signal was already aborted before we registered the listener —
    // in that scenario the "abort" event has already fired and won't fire again.
    opts.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
    if (opts.abortSignal.aborted) ac.abort();
    let aborted = false;

    async function* makeEvents(): AsyncGenerator<NormalizedEvent> {
      const sessionId = `echo-${Date.now().toString(36)}`;
      yield { kind: "init", sessionId, model: opts.model || "echo" };

      if (ac.signal.aborted || aborted) {
        yield { kind: "done", reason: "abort" };
        return;
      }

      const promptText =
        typeof opts.prompt === "string"
          ? opts.prompt
          : await collectPrompt(opts.prompt);

      if (ac.signal.aborted || aborted) {
        yield { kind: "done", reason: "abort" };
        return;
      }

      yield { kind: "text", text: promptText, role: "assistant" };
      yield { kind: "done", reason: "stop" };
    }

    const control: HarnessRunControl = {
      abort(): void {
        aborted = true;
        ac.abort();
      },
    };

    return { events: makeEvents(), control };
  }
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

export const echoHarness = new EchoHarness();
registerHarness(echoHarness);
