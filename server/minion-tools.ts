/**
 * Status-reporting MCP tools for Minion agents.
 *
 * Replaces the text-marker convention ([STEP], [DONE], [FAIL]) with
 * proper MCP tools so the UI gets structured, guaranteed-parseable events.
 *
 * Every status event is emitted on the minion's session topic via the
 * shared `Bus` — see `server/bus.ts`.
 *
 * Returns NormalizedToolDef[] which agents/minion.ts places into a toolGroup
 * keyed "minion-status". ClaudeHarness.registerTools() wraps them as a
 * named MCP server so tool calls follow the mcp__minion-status__* pattern.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import type { Bus } from "./bus.ts";

// ── Factory ────────────────────────────────────────────

export function createMinionToolsForSession(opts: {
  minionSessionKey: string;
  bus: Bus;
  leaderSessionKey?: string | null;
  taskId?: string | null;
  onReport?: (report: {
    trigger: "step" | "done" | "fail";
    message: string;
    timestamp: number;
  }) => void;
}): { toolDefs: NormalizedToolDef[] } {
  const { minionSessionKey, bus, leaderSessionKey, taskId, onReport } = opts;

  const emitStatus = (
    trigger: "step" | "done" | "fail",
    message: string,
  ): void => {
    const timestamp = Date.now();
    const payload = {
      type: "minion_status",
      minionSessionKey,
      trigger,
      message,
      timestamp,
      ...(leaderSessionKey ? { leaderSessionKey } : {}),
      ...(taskId ? { taskId } : {}),
    };

    bus.emitToSession(minionSessionKey, payload);
    if (leaderSessionKey) {
      bus.emitToSession(leaderSessionKey, payload);
    }
    onReport?.({ trigger, message, timestamp });
  };

  const reportStepDef: NormalizedToolDef = {
    name: "report_step",
    description:
      "Report a progress step to the UI. Call this when starting a meaningful phase of work (e.g. reading files, implementing, testing).",
    inputSchema: z.object({
      message: z.string().describe("Short description of what you're doing now"),
    }),
    handler: async (input: unknown) => {
      const args = input as { message: string };
      emitStatus("step", args.message);
      return {
        content: [{ type: "text" as const, text: `Step reported: ${args.message}` }],
      };
    },
  };

  const reportDoneDef: NormalizedToolDef = {
    name: "report_done",
    description:
      "Report task completion. Call exactly once when the current task is finished successfully.",
    inputSchema: z.object({
      summary: z.string().describe("One-line summary of what was accomplished"),
    }),
    handler: async (input: unknown) => {
      const args = input as { summary: string };
      emitStatus("done", args.summary);
      return {
        content: [{ type: "text" as const, text: `Task completed: ${args.summary}` }],
      };
    },
  };

  const reportFailDef: NormalizedToolDef = {
    name: "report_fail",
    description:
      "Report task failure. Call exactly once if you cannot complete the current task.",
    inputSchema: z.object({
      reason: z.string().describe("One-line reason for failure"),
    }),
    handler: async (input: unknown) => {
      const args = input as { reason: string };
      emitStatus("fail", args.reason);
      return {
        content: [{ type: "text" as const, text: `Task failed: ${args.reason}` }],
      };
    },
  };

  return { toolDefs: [reportStepDef, reportDoneDef, reportFailDef] };
}
