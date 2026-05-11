/**
 * Translate Codex SDK ThreadEvent → NormalizedEvent[].
 *
 * Stateful: elapsedSeconds for tool_progress is computed against a per-id
 * startedAt timestamp seeded on item.started. Use createCodexTranslator() to
 * create a translator that owns its own state for one stream.
 *
 * Pure: no I/O, no SDK calls beyond type imports.
 *
 * Mapping table lives in docs/codex-harness-spec.md §"Event translation".
 */

import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { NormalizedEvent } from "../../../shared/normalized-event.ts";

// ── Public interface ──────────────────────────────────────────────────────────

export interface TranslatorContext {
  /** Model name embedded in the init event. */
  model: string;
  /**
   * Accepted for compatibility with the outer generator's sessionId closure;
   * the translator reads thread_id directly from thread.started events.
   */
  sessionId?: () => string;
}

export interface CodexTranslator {
  translate(evt: ThreadEvent): NormalizedEvent[];
}

/**
 * Create a stateful Codex event translator for one runStreamed call.
 *
 * The returned translator holds a per-item startedAt map so it can compute
 * elapsedSeconds for tool_progress events. Create one translator per stream.
 */
export function createCodexTranslator(ctx: TranslatorContext): CodexTranslator {
  /** Maps item id → Date.now() when item.started was received. */
  const startedAt = new Map<string, number>();

  function computeElapsed(id: string): number {
    const started = startedAt.get(id);
    if (started === undefined) return 0;
    return (Date.now() - started) / 1000;
  }

  function handleItemStarted(item: ThreadItem): NormalizedEvent[] {
    startedAt.set(item.id, Date.now());

    switch (item.type) {
      case "mcp_tool_call":
        return [
          {
            kind: "tool_call",
            id: item.id,
            name: `mcp__${item.server}__${item.tool}`,
            input: item.arguments,
          },
        ];

      case "command_execution":
        return [
          {
            kind: "tool_call",
            id: item.id,
            name: "codex_command",
            input: { command: item.command },
          },
        ];

      case "file_change":
        return [
          {
            kind: "tool_call",
            id: item.id,
            name: "codex_file_change",
            input: {},
          },
        ];

      default:
        return [];
    }
  }

  function handleItemUpdated(item: ThreadItem): NormalizedEvent[] {
    const elapsedSeconds = computeElapsed(item.id);

    switch (item.type) {
      case "mcp_tool_call":
        return [
          {
            kind: "tool_progress",
            id: item.id,
            name: `mcp__${item.server}__${item.tool}`,
            elapsedSeconds,
          },
        ];

      case "command_execution":
        return [
          {
            kind: "tool_progress",
            id: item.id,
            name: "codex_command",
            elapsedSeconds,
          },
        ];

      default:
        return [];
    }
  }

  function handleItemCompleted(item: ThreadItem): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];

    switch (item.type) {
      case "mcp_tool_call":
        if (item.status === "failed") {
          events.push({
            kind: "tool_result",
            callId: item.id,
            output: item.error?.message ?? "Unknown error",
            isError: true,
          });
        } else {
          events.push({
            kind: "tool_result",
            callId: item.id,
            output: item.result ?? null,
            isError: false,
          });
        }
        break;

      case "command_execution":
        events.push({
          kind: "tool_result",
          callId: item.id,
          output: {
            command: item.command,
            aggregated_output: item.aggregated_output,
            exit_code: item.exit_code,
          },
          isError: item.status === "failed",
        });
        break;

      case "file_change":
        // Emit a synthetic tool_call if item.started was never seen for this id.
        // Codex may not emit item.started for file_change; the synthetic event
        // ensures consumers always see a call/result pair.
        if (!startedAt.has(item.id)) {
          events.push({
            kind: "tool_call",
            id: item.id,
            name: "codex_file_change",
            input: {},
          });
        }
        events.push({
          kind: "tool_result",
          callId: item.id,
          output: { changes: item.changes, status: item.status },
          isError: item.status === "failed",
        });
        break;

      case "web_search":
        events.push({
          kind: "tool_result",
          callId: item.id,
          output: { query: item.query },
          isError: false,
        });
        break;

      case "agent_message":
        events.push({ kind: "text", role: "assistant", text: item.text });
        break;

      case "reasoning":
        events.push({ kind: "thinking", text: item.text });
        break;

      case "todo_list":
        // MVP: swallow — see docs/codex-harness-spec.md Open Questions §2.
        break;

      case "error":
        // Non-fatal in-turn error; closest existing NormalizedEvent variant.
        events.push({
          kind: "permission_denial",
          tool: "codex",
          reason: item.message,
        });
        break;
    }

    return events;
  }

  return {
    translate(evt: ThreadEvent): NormalizedEvent[] {
      switch (evt.type) {
        case "thread.started":
          return [{ kind: "init", sessionId: evt.thread_id, model: ctx.model }];

        case "turn.started":
          return [];

        case "item.started":
          return handleItemStarted(evt.item);

        case "item.updated":
          return handleItemUpdated(evt.item);

        case "item.completed":
          return handleItemCompleted(evt.item);

        case "turn.completed":
          return [
            {
              kind: "usage",
              input: evt.usage.input_tokens,
              output: evt.usage.output_tokens,
              cacheRead: evt.usage.cached_input_tokens,
            },
          ];

        case "turn.failed":
          return [{ kind: "done", reason: "error", error: evt.error.message }];

        case "error":
          return [{ kind: "done", reason: "error", error: evt.message }];

        default:
          return [];
      }
    },
  };
}
