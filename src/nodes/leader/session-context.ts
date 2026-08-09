/**
 * Session-context helpers for the Leader node.
 *
 * Pure, side-effect-free utilities for translating LeaderData into
 * shapes the session-stream hook and prompt builder expect.
 */

import { msgId as sharedMsgId } from "../../sdk-messages.ts";
import type { SessionStreamState } from "../../session-stream.ts";
import type { LeaderData, LeaderMessage, TaskPlanItem } from "./types.ts";

/** Stable id generator for synthesized leader messages. */
export function msgId(): string {
  return sharedMsgId("lm");
}

/**
 * Project a {@link LeaderData} onto the shared {@link SessionStreamState}
 * shape consumed by `useSessionStream`. LeaderData's `status` union is
 * identical to the stream-state status union, so no remapping is needed.
 */
export function extractLeaderCore(d: LeaderData): SessionStreamState {
  return {
    sessionKey: d.sessionKey,
    status: d.status,
    messages: d.messages,
    streamingText: d.streamingText,
    streamingBlockIndex: d.streamingBlockIndex ?? null,
    totalCost: d.totalCost,
    turns: d.turns,
    error: d.error,
    fullError: d.fullError ?? null,
  };
}

/**
 * Build a context block from previous session messages and task plan.
 * Used when restarting a leader session post-disconnect so the new
 * Claude instance understands what happened in the prior session.
 *
 * Returns an empty string if there's nothing meaningful to include.
 */
export function buildSessionContext(
  messages: LeaderMessage[],
  taskPlan: TaskPlanItem[] = [],
  taskName?: string | null,
): string {
  // Only include user/assistant/result messages with meaningful content
  const conversationEntries = messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant" || m.role === "result") &&
        m.content.trim().length > 0,
    )
    .map((m) => {
      const role = m.role === "result" ? "assistant (result)" : m.role;
      // Truncate very long individual messages to keep context manageable
      const content =
        m.content.length > 2000
          ? m.content.slice(0, 1997) + "…"
          : m.content;
      return `[${role}]: ${content}`;
    });

  if (conversationEntries.length === 0 && taskPlan.length === 0) {
    return "";
  }

  const parts: string[] = [];

  parts.push("<previous-session-context>");
  parts.push(
    "This is a CONTINUATION session. A prior session existed in this leader node (it may have completed successfully, been restarted, or lost due to disconnect).",
  );
  parts.push(
    "Below is the conversation history and task state from the prior session.",
  );
  parts.push(
    "Use this to maintain continuity — do NOT repeat completed work. Build on what was already accomplished.\n",
  );

  if (taskName) {
    parts.push(`Session name: ${taskName}\n`);
  }

  // Task plan state
  if (taskPlan.length > 0) {
    parts.push("<task-plan>");
    for (const task of taskPlan) {
      const statusEmoji =
        task.status === "completed"
          ? "✅"
          : task.status === "running"
            ? "🔄"
            : task.status === "failed"
              ? "❌"
              : "📋";
      let line = `${statusEmoji} [${task.status}] ${task.title}`;
      if (task.result) {
        const result =
          task.result.length > 500
            ? task.result.slice(0, 497) + "…"
            : task.result;
        line += ` → ${result}`;
      }
      parts.push(line);
    }
    parts.push("</task-plan>\n");
  }

  // Conversation history — cap at ~30k chars total to stay within context limits
  if (conversationEntries.length > 0) {
    parts.push("<conversation-history>");
    let totalLen = 0;
    const MAX_CONTEXT_CHARS = 30000;
    // Include from newest to oldest, then reverse for chronological order
    const included: string[] = [];
    for (let i = conversationEntries.length - 1; i >= 0; i--) {
      const entry = conversationEntries[i];
      if (entry === undefined) continue;
      if (totalLen + entry.length > MAX_CONTEXT_CHARS) {
        included.push(
          `[... ${i + 1} earlier messages omitted for brevity ...]`,
        );
        break;
      }
      included.push(entry);
      totalLen += entry.length;
    }
    included.reverse();
    parts.push(included.join("\n\n"));
    parts.push("</conversation-history>");
  }

  parts.push("</previous-session-context>");

  return parts.join("\n");
}
