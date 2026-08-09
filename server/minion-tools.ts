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
import { okResult } from "./harness/tool-result.ts";
import type { Bus } from "./bus.ts";

export function createMinionToolsForSession(opts: {
  minionSessionKey: string;
  bus: Bus;
  leaderSessionKey?: string | null;
  taskId?: string | null;
  onReport?: (report: {
    trigger: "step" | "done" | "fail" | "blocked";
    message: string;
    timestamp: number;
  }) => void;
}): { toolDefs: NormalizedToolDef[] } {
  const { minionSessionKey, bus, leaderSessionKey, taskId, onReport } = opts;

  const emitStatus = (
    trigger: "step" | "done" | "fail" | "blocked",
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

  const reportStepInputSchema = z.object({
    message: z.string().describe("Short description of what you're doing now"),
  });

  const reportStepDef: NormalizedToolDef = {
    name: "report_step",
    description:
      "Report a progress step to the UI. Call this when starting a meaningful phase of work (e.g. reading files, implementing, testing).",
    inputSchema: reportStepInputSchema,
    handler: async (input: unknown) => {
      const args = reportStepInputSchema.parse(input);
      emitStatus("step", args.message);
      // Terse ack: the model already has its own message in context, so
      // echoing it back would only burn tokens. See harness/tool-result.ts.
      return okResult();
    },
  };

  const reportDoneInputSchema = z.object({
    summary: z
      .string()
      .describe(
        "One-line summary of what was accomplished. Lead with a tight summary; put long supporting detail in a repo/worktree file and reference its path instead of inlining it.",
      ),
  });

  const reportDoneDef: NormalizedToolDef = {
    name: "report_done",
    description:
      "Report task completion. Call exactly once when the current task is finished successfully. Keep the report summary-first; put long supporting detail in a repo/worktree artifact file and reference the path.",
    inputSchema: reportDoneInputSchema,
    handler: async (input: unknown) => {
      const args = reportDoneInputSchema.parse(input);
      emitStatus("done", args.summary);
      return okResult();
    },
  };

  const reportFailInputSchema = z.object({
    reason: z
      .string()
      .describe(
        "One-line reason for failure. Lead with a tight summary; put long supporting detail in a repo/worktree file and reference its path instead of inlining it.",
      ),
  });

  const reportFailDef: NormalizedToolDef = {
    name: "report_fail",
    description:
      "Report task failure. Call exactly once if you cannot complete the current task. Keep the report summary-first; put long supporting detail in a repo/worktree artifact file and reference the path.",
    inputSchema: reportFailInputSchema,
    handler: async (input: unknown) => {
      const args = reportFailInputSchema.parse(input);
      emitStatus("fail", args.reason);
      return okResult();
    },
  };

  const reportBlockedInputSchema = z.object({
    question: z
      .string()
      .describe(
        "What you are blocked on — the question or decision the leader must resolve before you can proceed. Lead with a tight summary; put long supporting detail in a repo/worktree file and reference its path instead of inlining it.",
      ),
  });

  const reportBlockedDef: NormalizedToolDef = {
    name: "report_blocked",
    description:
      "Report that you are blocked and need leader input. Use this instead of report_fail when you cannot proceed without a decision or answer. Your turn ends and the leader is woken to respond; they can reply via message_task to unblock you. This does NOT fail the task. Keep the report summary-first; put long supporting detail in a repo/worktree artifact file and reference the path.",
    inputSchema: reportBlockedInputSchema,
    handler: async (input: unknown) => {
      const args = reportBlockedInputSchema.parse(input);
      emitStatus("blocked", args.question);
      return okResult();
    },
  };

  return {
    toolDefs: [reportStepDef, reportDoneDef, reportFailDef, reportBlockedDef],
  };
}
