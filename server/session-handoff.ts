import { persistContextSource } from "./context-source.ts";
import type { SessionHost, StartSessionOptions } from "./session-host.ts";
import { compileContextCheckpoint, renderCheckpointPrompt } from "./context-checkpoint.ts";
import { renderConnectedHandoff, userTextFromPrompt } from "../shared/handoff-text.ts";
import { getSessionCanvasContext } from "./canvas-context-store.ts";

/** Reseed fresh threads on the server, including automatic wakes without a client. */
export function buildFreshThreadPrompt(host: SessionHost, opts: StartSessionOptions,
  prompt: string | AsyncIterable<{ role: "user"; content: string }>): string | AsyncIterable<{ role: "user"; content: string }> {
  if (host.role !== "leader" || (opts.resumeId && opts.invocationKind !== "provider_continuation")) return prompt;
  const connected = host.continuity?.canvasContext !== undefined ? host.continuity.canvasContext
    : host.canvasContext ?? getSessionCanvasContext(host.id);
  const prefix = (text: string): string => {
    const history = !text.includes("<context-checkpoint") && !text.includes("<previous-run-context>")
      && (host.contextCheckpoint || host.continuity?.directives.some(d => d !== userTextFromPrompt(text))
        || host.eventBuffer.some(row => row.type === "sdk_event"
        && row.event?.kind === "text" && row.event.role === "assistant"))
      ? renderCheckpointPrompt(compileContextCheckpoint(host, {
        trigger: "context_recovery", originalPrompt: opts.continuitySource === "system" ? "" : text, persist: false,
      })) : "";
    return [history, connected && !text.includes("<connected-context>")
      ? renderConnectedHandoff(connected, persistContextSource(host.worktree?.projectPath ?? host.cwd, connected)) : "", text].filter(Boolean).join("\n\n");
  };
  if (typeof prompt === "string") return prefix(prompt);
  return (async function* () {
    let first = true;
    for await (const message of prompt) {
      yield first ? { ...message, content: prefix(message.content) } : message;
      first = false;
    }
  })();
}
