import type { NormalizedEvent } from "../../../shared/normalized-event.ts";

export interface OpenCodeTranslator {
  translate(value: unknown): NormalizedEvent[];
  ensureInit(): NormalizedEvent[];
  result(): string;
  terminalSeen(): boolean;
}

export function createOpenCodeTranslator(model: string, fallbackSessionId: string): OpenCodeTranslator {
  let initialized = false;
  let terminal = false;
  let text = "";
  const toolCalls = new Set<string>();

  const init = (sessionId = fallbackSessionId): NormalizedEvent[] => {
    if (initialized) return [];
    initialized = true;
    return [{ kind: "init", sessionId, model }];
  };

  return {
    ensureInit: () => init(),
    result: () => text,
    terminalSeen: () => terminal,
    translate(value: unknown): NormalizedEvent[] {
      const event = record(value);
      if (!event) return [];
      const part = record(event["part"]);
      const sessionId = stringValue(part?.["sessionID"] ?? event["sessionID"]);
      const events = init(sessionId || fallbackSessionId);
      const type = stringValue(event["type"]);

      if (type === "text") {
        const chunk = stringValue(part?.["text"] ?? event["text"]);
        if (chunk) {
          text += chunk;
          events.push({ kind: "text", role: "assistant", text: chunk, ...(stringValue(part?.["id"]) ? { id: stringValue(part?.["id"]) } : {}) });
        }
      } else if (type === "reasoning") {
        const reasoning = stringValue(part?.["text"] ?? event["text"]);
        if (reasoning) events.push({ kind: "thinking", text: reasoning });
      } else if (type === "tool_use") {
        const state = record(part?.["state"]);
        const callId = stringValue(part?.["callID"] ?? part?.["id"]) || `opencode-tool-${toolCalls.size + 1}`;
        const tool = stringValue(part?.["tool"]) || "opencode_tool";
        if (!toolCalls.has(callId)) {
          toolCalls.add(callId);
          events.push({ kind: "tool_call", id: callId, name: tool, input: state?.["input"] ?? {} });
        }
        const status = stringValue(state?.["status"]);
        if (status === "completed" || status === "error") {
          events.push({ kind: "tool_result", callId, output: status === "error" ? state?.["error"] : state?.["output"], isError: status === "error" });
        }
      } else if (type === "step_finish") {
        const tokens = record(part?.["tokens"]);
        const cache = record(tokens?.["cache"]);
        if (tokens) events.push({
          kind: "usage",
          source: "turn_completed",
          input: numberValue(tokens["input"]),
          output: numberValue(tokens["output"]),
          cacheRead: numberValue(cache?.["read"]),
          cacheCreation: numberValue(cache?.["write"]),
          costUSD: numberOptional(part?.["cost"]),
          ...(sessionId ? { sdkSessionId: sessionId } : {}),
        });
      } else if (type === "error") {
        terminal = true;
        events.push({ kind: "done", reason: "error", error: stringValue(event["message"] ?? event["error"]) || "OpenCode run failed" });
      } else if (type === "permission" || type === "permission_asked") {
        events.push({ kind: "permission_denial", tool: stringValue(part?.["tool"]) || "opencode", reason: "OpenCode requested interactive permission during a headless run" });
      }
      return events;
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown): number { return typeof value === "number" && value >= 0 ? value : 0; }
function numberOptional(value: unknown): number | undefined { return typeof value === "number" && value >= 0 ? value : undefined; }
