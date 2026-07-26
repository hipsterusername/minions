/**
 * WebSocket command registry + dispatcher.
 *
 * Phase 5.2 replaces the ~1100-line `switch (cmd.type)` in `server/index.ts`
 * with a table of per-command handlers. Adding a new command now means:
 *
 *   1. Add its name to `WsCommandType` in `./types.ts`
 *   2. Create `./<new-command>.ts` exporting a `CommandHandler`
 *   3. Register it in `COMMAND_TABLE` below
 *
 * Exhaustiveness is enforced at the type level: `COMMAND_TABLE` is annotated
 * `CommandTable = Readonly<Record<WsCommandType, CommandHandler>>` and uses
 * `satisfies` so a missing or extra entry is a compile error. No runtime
 * fitness test required.
 */

import { unicastGlobal } from "../bus.ts";
import { createSession } from "./create-session.ts";
import { sendMessage } from "./send-message.ts";
import { canvasContext } from "./canvas-context.ts";
import { stopSession } from "./stop-session.ts";
import { syncSession } from "./sync-session.ts";
import { listSessions } from "./list-sessions.ts";
import { listHarnesses } from "./list-harnesses.ts";
import { acknowledgeSession, dismissSession, reopenSession } from "./session-review.ts";
import { interrupt, interruptSession } from "./interrupt.ts";
import { closeSession } from "./close-session.ts";
import { removeSession } from "./remove-session.ts";
import { setPermissionMode } from "./set-permission-mode.ts";
import { setModel } from "./set-model.ts";
import { stopTask } from "./stop-task.ts";
import { mergeWorktree } from "./merge-worktree.ts";
import { discardWorktree } from "./discard-worktree.ts";
import { getWorktreeDiff } from "./get-worktree-diff.ts";
import { approveChanges } from "./approve-changes.ts";
import { forceMerge } from "./force-merge.ts";
import { theirsMerge } from "./theirs-merge.ts";
import { retryMerge } from "./retry-merge.ts";
import { rewindFiles } from "./rewind-files.ts";
import { seedReadState } from "./seed-read-state.ts";
import {
  getContextUsage,
  getUsageReport,
  getProviderUsageReport,
  getSupportedModels,
  getSupportedCommands,
  getSupportedAgents,
  getAccountInfo,
  getMcpServerStatus,
} from "./info-queries.ts";
import { reconnectMcpServer, toggleMcpServer } from "./mcp-control.ts";
import { submitForm } from "./submit-form.ts";
import { clearSession } from "./clear-session.ts";
import { startDialectic, stopDialectic } from "./dialectic.ts";
import { getSystemModelStatus } from "./get-system-model-status.ts";
import { getSystemGraph } from "./get-system-graph.ts";
import { getWorkPackets } from "./get-work-packets.ts";
import { waiveReviewGate } from "./waive-review-gate.ts";
import { workItemCommand } from "./work-items.ts";
import { worktreeIntegrationCommand } from "./worktree-integration.ts";
import { listWorktreeLineages } from "./list-worktree-lineages.ts";
import type { CommandContext, CommandTable, WsCommand } from "./types.ts";
import type { WebSocket } from "ws";

/**
 * The single source of truth for every WS command the server accepts. Kept
 * as a `Readonly<Record<WsCommandType, CommandHandler>>` so the type
 * checker will flag any missing entry.
 */
export const COMMAND_TABLE = {
  // Session lifecycle
  create_session: createSession,
  send_message: sendMessage,
  canvas_context: canvasContext,
  stop_session: stopSession,
  sync_session: syncSession,
  list_sessions: listSessions,
  list_harnesses: listHarnesses,
  acknowledge_session: acknowledgeSession,
  dismiss_session: dismissSession,
  reopen_session: reopenSession,
  create_work_item: workItemCommand,
  continue_work_item: workItemCommand,
  start_work_item_run: workItemCommand,
  reply_to_waiting_run: workItemCommand,
  review_work_item: workItemCommand,
  archive_work_item: workItemCommand,
  restore_work_item: workItemCommand,
  attach_work_item_surface: workItemCommand,
  detach_work_item_surface: workItemCommand,
  get_work_item: workItemCommand,
  list_work_items: workItemCommand,
  get_work_item_runs: workItemCommand,
  update_work_item_card: workItemCommand,
  move_work_item_card: workItemCommand,
  import_kanban_board: workItemCommand,
  create_worktree_lineage: worktreeIntegrationCommand,
  join_worktree_lineage: worktreeIntegrationCommand,
  review_worktree_contribution: worktreeIntegrationCommand,
  enqueue_worktree_contribution: worktreeIntegrationCommand,
  retry_worktree_contribution: worktreeIntegrationCommand,
  discard_worktree_contribution: worktreeIntegrationCommand,
  review_worktree_lineage: worktreeIntegrationCommand,
  waive_worktree_integration_gate: worktreeIntegrationCommand,
  resolve_worktree_conflict: worktreeIntegrationCommand,
  promote_worktree_lineage: worktreeIntegrationCommand,
  get_worktree_lineage_status: worktreeIntegrationCommand,
  list_worktree_lineages: listWorktreeLineages,
  // Execution control
  interrupt,
  interrupt_session: interruptSession,
  close_session: closeSession,
  // Configuration control
  set_permission_mode: setPermissionMode,
  set_model: setModel,
  // Task control
  stop_task: stopTask,
  // Worktree control
  merge_worktree: mergeWorktree,
  discard_worktree: discardWorktree,
  get_worktree_diff: getWorktreeDiff,
  approve_changes: approveChanges,
  force_merge: forceMerge,
  theirs_merge: theirsMerge,
  retry_merge: retryMerge,
  remove_session: removeSession,
  // File & state control
  rewind_files: rewindFiles,
  seed_read_state: seedReadState,
  // Info queries
  get_context_usage: getContextUsage,
  get_usage_report: getUsageReport,
  get_provider_usage_report: getProviderUsageReport,
  get_supported_models: getSupportedModels,
  get_supported_commands: getSupportedCommands,
  get_supported_agents: getSupportedAgents,
  get_account_info: getAccountInfo,
  get_mcp_server_status: getMcpServerStatus,
  get_system_model_status: getSystemModelStatus,
  get_system_graph: getSystemGraph,
  get_work_packets: getWorkPackets,
  waive_review_gate: waiveReviewGate,
  // MCP server control
  reconnect_mcp_server: reconnectMcpServer,
  toggle_mcp_server: toggleMcpServer,
  // Render-DSL interactive components
  submit_form: submitForm,
  // Session history
  clear_session: clearSession,
  // Dialectic dual-planner (experimental)
  start_dialectic: startDialectic,
  stop_dialectic: stopDialectic,
} satisfies CommandTable;

/**
 * Look up and invoke the handler for a command envelope. Unknown command
 * types surface as a client-visible error event.
 */
export function dispatchCommand(
  ctx: CommandContext,
  cmd: WsCommand,
  ws: WebSocket,
): void {
  const handler = COMMAND_TABLE[cmd.type];
  if (!handler) {
    unicastGlobal(ws, {
      type: "error",
      message: `Unknown command type: ${String(cmd.type)}`,
    });
    return;
  }
  void Promise.resolve(handler(ctx, cmd, ws)).catch(() => {
    unicastGlobal(ws, { type: "error", message: "Command failed" });
  });
}

export type { CommandContext, CommandHandler, WsCommand, WsCommandType, CommandTable } from "./types.ts";
