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
 *
 * See docs/model-agnosticism-spec.md §5 Phase 8.
 */

import { registerHarness } from "../index.ts";
import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessStartOptions,
  NormalizedToolDef,
} from "../types.ts";
import type { NormalizedEvent } from "../../../shared/normalized-event.ts";

// ── Capability declaration ────────────────────────────────────────────────────

const ECHO_CAPABILITIES: HarnessCapabilities = {
  thinking: false,
  promptCaching: false,
  mcp: false,
  permissionPrompts: false,
  resume: false,
  partialMessages: false,
  builtInFilesystem: false,
};

// ── EchoHarness ───────────────────────────────────────────────────────────────

class EchoHarness implements AgentHarness {
  readonly name = "echo";
  readonly capabilities = ECHO_CAPABILITIES;
  readonly builtInTools: string[] = [];

  private aborted = false;
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

  /** Abort a running session. Idempotent. */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Yield `init`, then an assistant `text` event containing the prompt text,
   * then `done`. If `abort()` is called before the generator resumes, the
   * session ends with `reason: "abort"`.
   */
  async *start(opts: HarnessStartOptions): AsyncIterable<NormalizedEvent> {
    this.aborted = false;

    const sessionId = `echo-${Date.now().toString(36)}`;
    yield { kind: "init", sessionId, model: opts.model || "echo" };

    if (opts.abortSignal.aborted || this.aborted) {
      yield { kind: "done", reason: "abort" };
      return;
    }

    const promptText =
      typeof opts.prompt === "string"
        ? opts.prompt
        : await collectPrompt(opts.prompt);

    if (opts.abortSignal.aborted || this.aborted) {
      yield { kind: "done", reason: "abort" };
      return;
    }

    yield { kind: "text", text: promptText, role: "assistant" };
    yield { kind: "done", reason: "stop" };
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

export const echoHarness = new EchoHarness();
registerHarness(echoHarness);
