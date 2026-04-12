/**
 * Shared SDK message → display message conversion.
 *
 * De-duplicates logic previously copied between LeaderNode and MinionNode.
 * Splits assistant content blocks into separate display messages so the UI
 * can differentiate thinking, tool-use, and chat text.
 */

import type { SdkMessage, ContentBlock } from "./use-socket.ts";

// ── Display message (rendered in both Leader & Minion nodes) ──

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "result" | "thinking";
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** e.g. "8.6s · $0.0288" */
  suffix?: string;
  /** SDK message UUID — used for deduplication */
  sdkUuid?: string;
}

// ── Helpers ────────────────────────────────────────────

export function msgId(prefix = "m"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Extract only readable *text* from content blocks (no tool markers). */
export function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").replace(/<!--task-name:.+?-->\s*/g, "");
}

/**
 * Convert a raw SDK event into one or more DisplayMessages for the chat log.
 * Returns an empty array for events that shouldn't be rendered.
 *
 * For `assistant` messages, content blocks are split:
 *   - `thinking` blocks → role "thinking"
 *   - `text` blocks → role "assistant"
 *   - `tool_use` blocks → role "tool" (with toolName + toolInput)
 *
 * This eliminates the old pattern of jamming "[Tool: name]" into assistant
 * text, which caused visual duplication with tool_progress messages.
 */
export function sdkToDisplayMessages(
  sdkMsg: SdkMessage,
  prefix = "m",
): DisplayMessage[] {
  const now = Date.now();
  const uuid = "uuid" in sdkMsg ? (sdkMsg as { uuid?: string }).uuid : undefined;

  switch (sdkMsg.type) {
    case "system": {
      const sub = sdkMsg.subtype;
      if (sub === "init") {
        const model = sdkMsg.model ?? "unknown";
        return [{ id: msgId(prefix), role: "system", content: `Session on ${model}`, timestamp: now, sdkUuid: uuid }];
      }
      if (sub === "task_started") {
        return [{
          id: msgId(prefix),
          role: "system",
          content: `Subagent: ${sdkMsg.description ?? sdkMsg.task_id ?? "task"}`,
          timestamp: now,
          sdkUuid: uuid,
        }];
      }
      if (sub === "task_notification") {
        const ico = sdkMsg.status === "completed" ? "\u2713" : "\u2717";
        return [{
          id: msgId(prefix),
          role: "system",
          content: `${ico} Subagent ${sdkMsg.status}: ${sdkMsg.summary ?? ""}`,
          timestamp: now,
          sdkUuid: uuid,
        }];
      }
      if (sub === "local_command_output" && sdkMsg.content) {
        return [{ id: msgId(prefix), role: "system", content: sdkMsg.content, timestamp: now, sdkUuid: uuid }];
      }
      return [];
    }

    case "assistant": {
      if (!sdkMsg.message?.content) return [];

      const msgs: DisplayMessage[] = [];
      const blocks = sdkMsg.message.content;

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        if (block.type === "thinking" && block.thinking) {
          msgs.push({
            id: `${prefix}-${uuid ?? msgId(prefix)}-think-${i}`,
            role: "thinking",
            content: block.thinking,
            timestamp: now,
            sdkUuid: uuid,
          });
        } else if (block.type === "text" && block.text) {
          const text = block.text.replace(/<!--task-name:.+?-->\s*/g, "");
          if (text.trim()) {
            msgs.push({
              id: `${prefix}-${uuid ?? msgId(prefix)}-text-${i}`,
              role: "assistant",
              content: text,
              timestamp: now,
              sdkUuid: uuid,
            });
          }
        } else if (block.type === "tool_use" && block.name) {
          msgs.push({
            id: `${prefix}-${uuid ?? msgId(prefix)}-tool-${i}`,
            role: "tool",
            content: block.name,
            timestamp: now,
            toolName: block.name,
            toolInput: block.input,
            sdkUuid: uuid,
          });
        }
      }
      return msgs;
    }

    case "tool_progress":
      return [{
        id: msgId(prefix),
        role: "tool",
        content: `${sdkMsg.tool_name} (${sdkMsg.elapsed_time_seconds?.toFixed(1)}s)`,
        timestamp: now,
        toolName: sdkMsg.tool_name,
        sdkUuid: uuid,
      }];

    case "tool_use_summary":
      if (sdkMsg.summary) {
        return [{ id: msgId(prefix), role: "system", content: sdkMsg.summary, timestamp: now, sdkUuid: uuid }];
      }
      return [];

    case "result": {
      const txt = (sdkMsg.result ?? (sdkMsg.is_error ? "Error" : "Done")).replace(/<!--task-name:.+?-->\s*/g, "");
      const ds = sdkMsg.duration_ms ? `${(sdkMsg.duration_ms / 1000).toFixed(1)}s` : null;
      const cs = sdkMsg.total_cost_usd ? `$${sdkMsg.total_cost_usd.toFixed(4)}` : null;
      const sfx = [ds, cs].filter(Boolean).join(" · ");
      return [{ id: msgId(prefix), role: "result", content: txt, timestamp: now, suffix: sfx || undefined, sdkUuid: uuid }];
    }

    default:
      return [];
  }
}

/**
 * Legacy single-message wrapper for backward compatibility.
 * Returns the first display message or null.
 * @deprecated Use sdkToDisplayMessages for full fidelity.
 */
export function sdkToDisplayMessage(
  sdkMsg: SdkMessage,
  prefix = "m",
): DisplayMessage | null {
  const msgs = sdkToDisplayMessages(sdkMsg, prefix);
  return msgs.length > 0 ? msgs[0] : null;
}
