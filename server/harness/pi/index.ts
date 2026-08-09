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
import { streamJsonlProcess } from "../jsonl-process.ts";
import { tagTerminalProvenance } from "../terminal-provenance.ts";
import { getPiModels, resolvePiModel } from "./models.ts";
import { checkPiReadiness, resolvePiRuntime } from "./runtime.ts";
import { createPiTranslator } from "./translate.ts";
import type { PiTranslator } from "./translate.ts";

const CAPABILITIES: HarnessCapabilities = {
  mutationInterception: "observe_only",
  thinking: true,
  promptCaching: true,
  mcp: false,
  permissionPrompts: false,
  resume: true,
  partialMessages: true,
  builtInFilesystem: true,
};

const BUILT_IN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

class PiHarness implements AgentHarness {
  readonly name = "pi";
  readonly exposure = "production" as const;
  readonly capabilities = CAPABILITIES;
  readonly builtInTools = [...BUILT_IN_TOOLS];
  readonly checkReadiness = checkPiReadiness;

  registerTools(_toolGroups: Record<string, NormalizedToolDef[]>): void {
    // Pi's CLI has no native MCP bridge. Its configured extensions and built-in
    // tools remain available, which is reflected by capabilities.mcp=false.
  }

  resolveModel(model: string): string | null {
    return resolvePiModel(model);
  }

  staticInfo(): HarnessStaticInfo {
    return {
      models: getPiModels(),
      commands: [],
      agents: [],
      account: { provider: "pi" },
    };
  }

  start(opts: HarnessStartOptions): { events: AsyncIterable<NormalizedEvent>; control: HarnessRunControl } {
    const controller = new AbortController();
    opts.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    if (opts.abortSignal.aborted) controller.abort();

    const events = (async function* (): AsyncGenerator<NormalizedEvent> {
      let translator: PiTranslator | undefined;
      try {
        if (opts.attachments?.length) {
          yield fallbackInit(opts);
          yield taggedError("Image attachments are not supported by harness \"pi\" yet.");
          return;
        }
        if (Object.keys(opts.externalMcpServers ?? {}).length > 0) {
          yield fallbackInit(opts);
          yield taggedError("External project MCP wrappers are not supported by harness \"pi\"; configure tools through Pi extensions.");
          return;
        }
        const runtime = resolvePiRuntime();
        if (!runtime) {
          yield fallbackInit(opts);
          yield taggedError("Pi runtime is unavailable. Install pi or set PI_PATH.");
          return;
        }
        const prompt = await collectPrompt(opts.prompt);
        const args = ["--mode", "json", "--model", opts.model, "--system-prompt", opts.systemPrompt];
        if (opts.resumeId) args.push("--session", opts.resumeId);
        if (opts.thinking) args.push("--thinking", opts.thinking.effort);
        if (opts.permissionMode === "auto" || opts.permissionMode === "bypassPermissions") args.push("--approve");
        args.push(prompt);

        translator = createPiTranslator(opts.model, opts.resumeId ?? opts.sessionKey, opts.permissionMode);
        const stream = streamJsonlProcess({ executable: runtime.executable, args, cwd: opts.cwd, env: process.env, signal: controller.signal });
        let completion;
        while (true) {
          const next = await stream.next();
          if (next.done) { completion = next.value; break; }
          if (next.value.value === undefined) continue;
          for (const event of translator.translate(next.value.value)) {
            yield event.kind === "done" ? tagTerminalProvenance(event, "adapter") : event;
          }
        }
        if (!translator.terminalSeen()) {
          for (const event of translator.ensureInit()) yield event;
          if (controller.signal.aborted) {
            yield tagTerminalProvenance({ kind: "done", reason: "abort" }, "adapter");
          } else if (completion.code !== 0) {
            yield taggedError(completion.stderr || `Pi exited with status ${completion.code}`);
          } else {
            yield tagTerminalProvenance({ kind: "done", reason: "completed", result: translator.result() }, "adapter");
          }
        }
      } catch (error) {
        if (translator) {
          for (const event of translator.ensureInit()) yield event;
        } else {
          yield fallbackInit(opts);
        }
        yield taggedError(error instanceof Error ? error.message : "Pi adapter failed");
      }
    })();

    return { events, control: { abort: () => controller.abort(), close: async () => controller.abort() } };
  }
}

async function collectPrompt(prompt: HarnessStartOptions["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const messages: string[] = [];
  for await (const message of prompt) messages.push(message.content);
  return messages.join("\n\n");
}

function taggedError(message: string): NormalizedEvent {
  return tagTerminalProvenance({ kind: "done", reason: "error", error: message }, "adapter");
}

function fallbackInit(opts: HarnessStartOptions): NormalizedEvent {
  return { kind: "init", sessionId: opts.resumeId ?? opts.sessionKey, model: opts.model,
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}) };
}

registerHarness(new PiHarness());
