/**
 * set_task_name tool — Set a short display name for the leader session.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import type { TaskToolContext } from "./types.ts";

export function createSetTaskNameToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "set_task_name",
    description:
      "Set a short display name for this leader session (3-6 words). Call once at the start.",
    inputSchema: z.object({
      name: z.string().describe("Concise task name, 3-6 words"),
    }),
    handler: async (input: unknown) => {
      const args = input as { name: string };
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
  };
}
