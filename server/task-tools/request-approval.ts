/**
 * request_approval tool — Request user approval to merge worktree changes.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { errorResult, textResult } from "../harness/tool-result.ts";
import type { DetailedDiff } from "../worktree.js";
import { getDetailedDiff } from "../worktree.js";
import type { TaskToolContext } from "./types.ts";
import type { SessionHost } from "../session-host.ts";
import { evaluateMergeGates } from "../system-model/gates.ts";

export const APPROVAL_GRACE_MS = 15_000;

const requestApprovalInputSchema = z.object({
  summary: z
    .string()
    .describe(
      "A concise summary of all changes made and why — this is shown to the user in the approval UI",
    ),
});

export function createRequestApprovalToolDef(ctx: TaskToolContext): NormalizedToolDef {
  return {
    name: "request_approval",
    description:
      "REQUIRED as your final action: Request user approval to merge worktree changes into the main branch. Call this after ALL work is complete. Automatically gathers a detailed diff and triggers the Approve/Discard UI buttons for the user. IMPORTANT: Immediately after calling this tool, you MUST call render_set to display a change summary dashboard showing the diff details returned by this tool.",
    inputSchema: requestApprovalInputSchema,
    handler: async (input: unknown) => {
      const args = requestApprovalInputSchema.parse(input);
      const runtime = ctx.getSessionRuntime?.(ctx.leaderSessionKey);
      if (runtime?.workItemId) {
        return errorResult(
          "Canonical work-item contributions do not use legacy approval. Finish with a final summary report; contribution collection, gates, review, and lineage integration are handled by the canonical workflow.",
        );
      }
      if (!ctx.worktreeInfo) {
        return textResult(
          "No worktree is active — approval workflow is only available with worktree isolation enabled.",
        );
      }

      // Gather detailed diff
      let diff: DetailedDiff;
      try {
        diff = await getDetailedDiff(ctx.worktreeInfo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`Failed to gather diff: ${msg}`);
      }

      const requestedAt = Date.now();
      const graceUntil = requestedAt + APPROVAL_GRACE_MS;
      const gateHost = {
        id: ctx.leaderSessionKey,
        cwd: ctx.cwd,
        worktree: ctx.worktreeInfo,
      } as SessionHost;
      const gateVerdict = await evaluateMergeGates(gateHost);
      const gates = gateVerdict.mode === "off" ? null : gateVerdict;

      // Record approval state
      ctx.taskState.approval = {
        requested: true,
        requestedAt,
        graceUntil,
        summary: args.summary,
        diff,
        gates,
      };
      ctx.onStateChange?.(ctx.taskState);

      // Broadcast so the frontend can show approval UI
      ctx.bus.emitToSession(ctx.leaderSessionKey, {
        type: "approval_requested",
        sessionKey: ctx.leaderSessionKey,
        summary: args.summary,
        diff,
        gates,
        timestamp: requestedAt,
        graceUntil,
      });

      // Build the response. The diff appears exactly once, as the JSON rows
      // the agent must feed to render_set — a separate human-readable file
      // table would duplicate the same data in the model's context.
      const fileRows = JSON.stringify(
        diff.files.map((f) => [f.file, f.status, `+${f.insertions}`, `-${f.deletions}`])
      );

      const commitList = diff.commits.length > 0
        ? `\nCommits:\n${diff.commits.map((c) => `  • ${c}`).join("\n")}`
        : "";

      return textResult(
        [
          `Approval requested. The "Approve & Merge" and "Discard" buttons are now visible to the user.`,
          ``,
          `Branch: ${diff.branch}`,
          `Files changed: ${diff.filesChanged}  (+${diff.insertions} -${diff.deletions})${commitList}`,
          ``,
          `⚠️ NEXT STEP REQUIRED: You MUST now call render_set to display a change summary dashboard. Use these values:`,
          `- title: "Changes Ready for Review"`,
          `- A text component with your summary`,
          `- A table component with headers ["File", "Status", "+Lines", "-Lines"] and rows: ${fileRows}`,
          `- metric components: "${diff.filesChanged} files changed", "+${diff.insertions}", "-${diff.deletions}", "${diff.commits.length} commits"`,
          `- A status component with label "Approval" state "warning" (shows "Waiting for review")`,
          ``,
          `After rendering the dashboard, tell the user you're waiting for their review. Do NOT continue working.`,
        ].join("\n"),
      );
    },
  };
}
