/**
 * set_task_name tool — Set a short display name for the leader session.
 */

import { z } from "zod/v4";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { TaskToolContext } from "./types.ts";

export function createSetTaskNameTool(ctx: TaskToolContext) {
  return tool(
    "set_task_name",
    "Set a short display name for this leader session (3-6 words). Call once at the start.",
    {
      name: z.string().describe("Concise task name, 3-6 words"),
    },
    async (args) => {
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "session_task_name",
        sessionKey: ctx.leaderSessionKey,
        taskName: args.name,
      });
      return {
        content: [
          { type: "text" as const, text: `Task name set: ${args.name}` },
        ],
      };
    },
  );
}
