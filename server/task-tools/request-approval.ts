/**
 * request_approval tool — Request user approval to merge worktree changes.
 */

import { z } from "zod/v4";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { DetailedDiff } from "../worktree.js";
import { getDetailedDiff } from "../worktree.js";
import type { TaskToolContext } from "./types.ts";

export function createRequestApprovalTool(ctx: TaskToolContext) {
  return tool(
    "request_approval",
    "REQUIRED as your final action: Request user approval to merge worktree changes into the main branch. Call this after ALL work is complete. Automatically gathers a detailed diff and triggers the Approve/Discard UI buttons for the user. IMPORTANT: Immediately after calling this tool, you MUST call render_set to display a change summary dashboard showing the diff details returned by this tool.",
    {
      summary: z
        .string()
        .describe("A concise summary of all changes made and why — this is shown to the user in the approval UI"),
    },
    async (args) => {
      if (!ctx.worktreeInfo) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No worktree is active — approval workflow is only available with worktree isolation enabled.",
            },
          ],
        };
      }

      // Gather detailed diff
      let diff: DetailedDiff;
      try {
        diff = await getDetailedDiff(ctx.worktreeInfo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to gather diff: ${msg}`,
            },
          ],
        };
      }

      // Record approval state
      ctx.taskState.approval = {
        requested: true,
        requestedAt: Date.now(),
        summary: args.summary,
        diff,
      };

      // Broadcast so the frontend can show approval UI
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "approval_requested",
        sessionKey: ctx.leaderSessionKey,
        summary: args.summary,
        diff,
        timestamp: Date.now(),
      });

      // Build a response with the diff details AND explicit render instructions
      const fileTable = diff.files.map((f) => {
        const sign = f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~";
        return `  ${sign} ${f.file}  (+${f.insertions} -${f.deletions})`;
      }).join("\n");

      const commitList = diff.commits.length > 0
        ? `\nCommits:\n${diff.commits.map((c) => `  • ${c}`).join("\n")}`
        : "";

      // Pre-format the file rows as JSON for the agent to use in render_set
      const fileRows = JSON.stringify(
        diff.files.map((f) => [f.file, f.status, `+${f.insertions}`, `-${f.deletions}`])
      );

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✅ Approval requested successfully. The "Approve & Merge" and "Discard" buttons are now visible to the user.`,
              ``,
              `Branch: ${diff.branch}`,
              `Files changed: ${diff.filesChanged}  (+${diff.insertions} -${diff.deletions})`,
              fileTable,
              commitList,
              ``,
              `⚠️ NEXT STEP REQUIRED: You MUST now call render_set to display a change summary dashboard. Use these values:`,
              `- title: "Changes Ready for Review"`,
              `- A text component with your summary`,
              `- A table component with headers ["File", "Status", "+Lines", "-Lines"] and rows: ${fileRows}`,
              `- A metric component: "${diff.filesChanged} files changed"`,
              `- A metric component: "+${diff.insertions}" (color green)`,
              `- A metric component: "-${diff.deletions}" (color red)`,
              `- A metric component: "${diff.commits.length} commits"`,
              `- A status component with label "Approval" state "warning" (shows "Waiting for review")`,
              ``,
              `After rendering the dashboard, tell the user you're waiting for their review. Do NOT continue working.`,
            ].join("\n"),
          },
        ],
      };
    },
  );
}
