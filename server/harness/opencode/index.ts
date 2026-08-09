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
import { getBridgeServer } from "../../mcp-bridge/server.ts";
import type { McpBridgeRegistration } from "../../mcp-bridge/registry.ts";
import { buildOpenCodeEnv } from "./config.ts";
import { getOpenCodeModels, resolveOpenCodeModel } from "./models.ts";
import { checkOpenCodeReadiness, resolveOpenCodeRuntime } from "./runtime.ts";
import { createOpenCodeTranslator } from "./translate.ts";
import type { OpenCodeTranslator } from "./translate.ts";

const CAPABILITIES: HarnessCapabilities = {
  mutationInterception: "observe_only",
  thinking: true,
  promptCaching: true,
  mcp: true,
  permissionPrompts: false,
  resume: true,
  partialMessages: false,
  builtInFilesystem: true,
};

const BUILT_IN_TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "task", "webfetch"];

class OpenCodeHarness implements AgentHarness {
  readonly name = "opencode";
  readonly exposure = "production" as const;
  readonly capabilities = CAPABILITIES;
  readonly builtInTools = [...BUILT_IN_TOOLS];
  readonly checkReadiness = checkOpenCodeReadiness;

  private registeredGroups: Record<string, NormalizedToolDef[]> = {};

  registerTools(toolGroups: Record<string, NormalizedToolDef[]>): void {
    this.registeredGroups = toolGroups;
  }

  resolveModel(model: string): string | null {
    return resolveOpenCodeModel(model);
  }

  staticInfo(): HarnessStaticInfo {
    return {
      models: getOpenCodeModels(),
      commands: [],
      agents: [],
      account: { provider: "opencode" },
    };
  }

  start(opts: HarnessStartOptions): { events: AsyncIterable<NormalizedEvent>; control: HarnessRunControl } {
    const controller = new AbortController();
    opts.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    if (opts.abortSignal.aborted) controller.abort();
    const groups = Object.entries(this.registeredGroups)
      .filter(([, definitions]) => definitions.length > 0)
      .map(([name]) => name);
    const registeredGroups = { ...this.registeredGroups };

    const events = (async function* (): AsyncGenerator<NormalizedEvent> {
      let bridge: McpBridgeRegistration | undefined;
      let translator: OpenCodeTranslator | undefined;
      try {
        if (opts.attachments?.length) {
          yield fallbackInit(opts);
          yield taggedError("Image attachments are not supported by harness \"opencode\" yet.");
          return;
        }
        if (Object.keys(opts.externalMcpServers ?? {}).length > 0) {
          yield fallbackInit(opts);
          yield taggedError("External project MCP wrappers are not supported by harness \"opencode\"; configure them in opencode.json.");
          return;
        }
        const runtime = resolveOpenCodeRuntime();
        if (!runtime) {
          yield fallbackInit(opts);
          yield taggedError("OpenCode runtime is unavailable. Install opencode or set OPENCODE_PATH.");
          return;
        }
        if (groups.length > 0) {
          bridge = (await getBridgeServer()).register({ sessionKey: opts.sessionKey, groups: registeredGroups });
        }
        const env = buildOpenCodeEnv({ systemPrompt: opts.systemPrompt, bridge, groups });
        const args = ["run", "--format", "json", "--model", opts.model, "--auto"];
        if (opts.resumeId) args.push("--session", opts.resumeId);
        if (opts.thinking?.display === "summarized") args.push("--thinking");

        translator = createOpenCodeTranslator(opts.model, opts.resumeId ?? opts.sessionKey);
        const stream = streamJsonlProcess({
          executable: runtime.executable,
          args,
          cwd: opts.cwd,
          env,
          signal: controller.signal,
          stdin: await collectPrompt(opts.prompt),
        });
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
            yield taggedError(completion.stderr || `OpenCode exited with status ${completion.code}`);
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
        yield taggedError(error instanceof Error ? error.message : "OpenCode adapter failed");
      } finally {
        bridge?.dispose();
      }
    })();

    return {
      events,
      control: { abort: () => controller.abort(), close: async () => controller.abort() },
    };
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

registerHarness(new OpenCodeHarness());
