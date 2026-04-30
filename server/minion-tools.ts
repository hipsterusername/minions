/**
 * Status-reporting MCP tools for Minion agents.
 *
 * Replaces the text-marker convention ([STEP], [DONE], [FAIL]) with
 * proper MCP tools so the UI gets structured, guaranteed-parseable events.
 *
 * Every status event is emitted on the minion's session topic via the
 * shared `Bus` — see `server/bus.ts`.
 */

import { z } from "zod/v4";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Bus } from "./bus.ts";

// ── Factory ────────────────────────────────────────────

export function createMinionToolsForSession(opts: {
  minionSessionKey: string;
  bus: Bus;
}) {
  const { minionSessionKey, bus } = opts;

  const reportStepTool = tool(
    "report_step",
    "Report a progress step to the UI. Call this when starting a meaningful phase of work (e.g. reading files, implementing, testing).",
    {
      message: z.string().describe("Short description of what you're doing now"),
    },
    async (args) => {
      bus.emitToSession(minionSessionKey, {
        type: "minion_status",
        minionSessionKey,
        trigger: "step",
        message: args.message,
        timestamp: Date.now(),
      });
      return {
        content: [{ type: "text" as const, text: `Step reported: ${args.message}` }],
      };
    },
  );

  const reportDoneTool = tool(
    "report_done",
    "Report task completion. Call exactly once when the current task is finished successfully.",
    {
      summary: z.string().describe("One-line summary of what was accomplished"),
    },
    async (args) => {
      bus.emitToSession(minionSessionKey, {
        type: "minion_status",
        minionSessionKey,
        trigger: "done",
        message: args.summary,
        timestamp: Date.now(),
      });
      return {
        content: [{ type: "text" as const, text: `Task completed: ${args.summary}` }],
      };
    },
  );

  const reportFailTool = tool(
    "report_fail",
    "Report task failure. Call exactly once if you cannot complete the current task.",
    {
      reason: z.string().describe("One-line reason for failure"),
    },
    async (args) => {
      bus.emitToSession(minionSessionKey, {
        type: "minion_status",
        minionSessionKey,
        trigger: "fail",
        message: args.reason,
        timestamp: Date.now(),
      });
      return {
        content: [{ type: "text" as const, text: `Task failed: ${args.reason}` }],
      };
    },
  );

  const tools = [reportStepTool, reportDoneTool, reportFailTool] as const;

  const mcpServer = createSdkMcpServer({
    name: "minion-status",
    tools: [...tools],
  });

  // `tools` is exposed so tests (and any future in-process driver) can invoke
  // handlers directly without spinning up an MCP transport — same pattern as
  // `createRenderToolsForLeader`.
  return { mcpServer, tools };
}
