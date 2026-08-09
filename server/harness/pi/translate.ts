import type { NormalizedEvent } from "../../../shared/normalized-event.ts";

export interface PiTranslator {
  translate(value: unknown): NormalizedEvent[];
  ensureInit(): NormalizedEvent[];
  result(): string;
  terminalSeen(): boolean;
}

export function createPiTranslator(model: string, fallbackSessionId: string, permissionMode?: string): PiTranslator {
  let initialized = false;
  let terminal = false;
  let text = "";
  let sawTextDelta = false;
  let turns = 0;
  const toolStartedAt = new Map<string, number>();

  const init = (sessionId = fallbackSessionId): NormalizedEvent[] => {
    if (initialized) return [];
    initialized = true;
    return [{ kind: "init", sessionId, model, ...(permissionMode ? { permissionMode } : {}) }];
  };

  return {
    ensureInit: () => init(),
    result: () => text,
    terminalSeen: () => terminal,
    translate(value: unknown): NormalizedEvent[] {
      const event = record(value);
      if (!event) return [];
      const type = stringValue(event["type"]);
      const events = init(type === "session" ? stringValue(event["id"]) || fallbackSessionId : fallbackSessionId);

      if (type === "turn_start") {
        turns += 1;
      } else if (type === "message_update") {
        const update = record(event["assistantMessageEvent"]);
        const updateType = stringValue(update?.["type"]);
        const delta = stringValue(update?.["delta"]);
        if (updateType === "text_delta" && delta) {
          sawTextDelta = true;
          text += delta;
          events.push({ kind: "text_delta", text: delta, blockIndex: numberValue(update?.["contentIndex"]) });
        } else if ((updateType === "thinking_delta" || updateType === "reasoning_delta") && delta) {
          events.push({ kind: "thinking", text: delta });
        }
      } else if (type === "tool_execution_start") {
        const id = stringValue(event["toolCallId"]);
        toolStartedAt.set(id, Date.now());
        events.push({ kind: "tool_call", id, name: stringValue(event["toolName"]) || "pi_tool", input: event["args"] ?? {} });
      } else if (type === "tool_execution_update") {
        const id = stringValue(event["toolCallId"]);
        events.push({ kind: "tool_progress", id, name: stringValue(event["toolName"]) || "pi_tool", elapsedSeconds: elapsed(toolStartedAt.get(id)) });
      } else if (type === "tool_execution_end") {
        events.push({ kind: "tool_result", callId: stringValue(event["toolCallId"]), output: event["result"], isError: event["isError"] === true });
      } else if (type === "message_end") {
        const message = record(event["message"]);
        if (message?.["role"] === "assistant") {
          const finalText = extractText(message["content"]);
          if (!sawTextDelta && finalText) {
            text += finalText;
            events.push({ kind: "text", role: "assistant", text: finalText });
          }
          sawTextDelta = false;
          const usage = record(message["usage"]);
          const cost = record(usage?.["cost"]);
          if (usage) events.push({
            kind: "usage",
            source: "assistant",
            input: numberValue(usage["input"]),
            output: numberValue(usage["output"]),
            cacheRead: numberValue(usage["cacheRead"]),
            cacheCreation: numberValue(usage["cacheWrite"]),
            ...(typeof cost?.["total"] === "number" ? { costUSD: cost["total"] } : {}),
          });
          const stopReason = stringValue(message["stopReason"]);
          if (stopReason === "error" || stopReason === "aborted") {
            terminal = true;
            events.push({ kind: "done", reason: stopReason === "aborted" ? "abort" : "error", ...(stringValue(message["errorMessage"]) ? { error: stringValue(message["errorMessage"]) } : {}) });
          }
        }
      } else if (type === "agent_end") {
        terminal = true;
        events.push({ kind: "stream_end" }, { kind: "done", reason: "completed", result: text, turns });
      }
      return events;
    },
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    const item = record(block);
    return item?.["type"] === "text" && typeof item["text"] === "string" ? [item["text"]] : [];
  }).join("");
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown): number { return typeof value === "number" && value >= 0 ? value : 0; }
function elapsed(startedAt: number | undefined): number { return startedAt === undefined ? 0 : (Date.now() - startedAt) / 1000; }
