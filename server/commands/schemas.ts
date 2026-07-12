/**
 * Per-command zod schemas for every inbound WebSocket command.
 *
 * `server/ws-connection.ts` used to `JSON.parse(raw) as WsCommand` with zero
 * runtime validation — any client could smuggle arbitrarily-shaped payloads
 * straight into the handlers. `validateWsCommand` is now the gate the
 * dispatcher calls before a handler is invoked.
 *
 * Design notes:
 *   - Each schema lists only the fields its handler actually reads, with the
 *     same optionality the handlers tolerate today. Handlers keep their own
 *     "sessionKey required"-style guards, so a *missing* field still produces
 *     the familiar handler error; a *mistyped* field is rejected here before
 *     any handler runs.
 *   - Unknown keys are ignored (zod objects strip by default and we pass the
 *     original envelope through), so additive client fields don't break.
 *   - Exhaustiveness is compile-time enforced: `COMMAND_SCHEMAS` must have an
 *     entry for every `WsCommandType` (mirrors the `satisfies CommandTable`
 *     trick in `./index.ts`).
 */

import { z } from "zod/v4";
import { kanbanCardMetadataSchema, kanbanImportCardSchema } from "../../shared/work-item-kanban.ts";
import type { SessionRole } from "../session-host.ts";
import type { WsCommand, WsCommandType } from "./types.ts";
import { changeModeSchema } from "../../shared/work-item-lifecycle.ts";
import { workItemBindingSurfaceSchema } from "../../shared/work-item-contracts.ts";

// ── Field vocabulary ───────────────────────────────────────

const SESSION_ROLES = [
  "leader",
  "minion",
  "default",
  "card-composer",
] as const satisfies readonly SessionRole[];

// Compile-time guard: adding a SessionRole without updating SESSION_ROLES
// above flips this conditional type to `never` and fails the build.
type AllRolesCovered = SessionRole extends (typeof SESSION_ROLES)[number]
  ? true
  : never;
const allRolesCovered: AllRolesCovered = true;
void allRolesCovered;

const sessionKey = z.string().optional();
const requestId = z.string().optional();
const prompt = z.string().optional();
const cwd = z.string().optional();
const requiredId = z.string().min(1);
const workItemRequestId = z.string().uuid();
const mutationFields = {
  requestId: workItemRequestId,
  expectedLifecycleRevision: z.number().int().nonnegative(),
  expectedCurrentRunKey: requiredId.nullable(),
};

/** Mirrors `WsImageAttachment` in `./types.ts`. */
const attachmentSchema = z.object({
  kind: z.literal("image"),
  filename: z.string().optional(),
  mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  data: z.string(),
});

const canvasContextItemSchema = z.object({
  nodeId: z.string(),
  nodeType: z.string(),
  label: z.string(),
  content: z.string(),
  attachments: z.array(attachmentSchema).optional(),
});

const sessionConfigFields = {
  prompt,
  attachments: z.array(attachmentSchema).optional(),
  systemPrompt: z.string().optional(),
  // `thinkingConfig` is declared `unknown` on WsCommand; the handlers run it
  // through `isValidThinkingConfig` themselves.
  thinkingConfig: z.unknown().optional(),
  harness: z.string().optional(),
};

/** Build a command schema: `type` literal + requestId + per-command fields. */
function command<T extends WsCommandType>(type: T, fields: z.ZodRawShape) {
  return z.object({ type: z.literal(type), requestId, ...fields });
}

const sessionScoped = (type: WsCommandType) => command(type, { sessionKey });

// ── Per-command schemas ────────────────────────────────────

export const COMMAND_SCHEMAS = {
  // Session lifecycle
  create_session: command("create_session", {
    sessionKey,
    workItemId: z.string().min(1).optional(),
    cwd,
    role: z.enum(SESSION_ROLES).optional(),
    skillIds: z.array(z.string()).optional(),
    worktreeIsolation: z.boolean().optional(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    ...sessionConfigFields,
  }),
  send_message: command("send_message", {
    sessionKey,
    ...sessionConfigFields,
  }),
  canvas_context: command("canvas_context", {
    sessionKey,
    items: z.array(canvasContextItemSchema),
  }),
  stop_session: sessionScoped("stop_session"),
  sync_session: sessionScoped("sync_session"),
  list_sessions: command("list_sessions", {}),
  list_harnesses: command("list_harnesses", {}),
  acknowledge_session: command("acknowledge_session", {
    sessionKey: z.string().min(1),
    expectedLifecycleRevision: z.number().int().nonnegative(),
  }),
  dismiss_session: command("dismiss_session", {
    sessionKey: z.string().min(1),
    expectedLifecycleRevision: z.number().int().nonnegative(),
  }),
  reopen_session: command("reopen_session", {
    sessionKey: z.string().min(1),
    expectedLifecycleRevision: z.number().int().nonnegative(),
  }),
  // Durable work items
  create_work_item: command("create_work_item", {
    requestId: workItemRequestId,
    projectId: requiredId,
    projectPath: requiredId,
    title: requiredId,
    changeMode: changeModeSchema,
    workflowColumnId: requiredId.optional(),
    workflowRank: requiredId.optional(),
    cardPatch: kanbanCardMetadataSchema.optional(),
  }),
  start_work_item_run: command("start_work_item_run", {
    ...mutationFields, workItemId: requiredId, prompt: z.string().min(1),
    harness: requiredId.optional(), model: requiredId.optional(),
    permissionMode: requiredId.optional(), thinkingConfig: z.unknown().optional(),
    skillIds: z.array(requiredId).optional(), systemPrompt: requiredId.optional(),
    attachments: z.array(z.unknown()).optional(),
  }),
  reply_to_waiting_run: command("reply_to_waiting_run", {
    ...mutationFields, workItemId: requiredId, runKey: requiredId, prompt: z.string().min(1),
  }),
  review_work_item: command("review_work_item", {
    ...mutationFields, workItemId: requiredId,
  }),
  archive_work_item: command("archive_work_item", {
    ...mutationFields, workItemId: requiredId,
  }),
  restore_work_item: command("restore_work_item", {
    ...mutationFields, workItemId: requiredId,
  }),
  attach_work_item_surface: command("attach_work_item_surface", {
    ...mutationFields, workItemId: requiredId,
    surface: workItemBindingSurfaceSchema, bindingId: requiredId,
  }),
  detach_work_item_surface: command("detach_work_item_surface", {
    ...mutationFields, workItemId: requiredId,
    surface: workItemBindingSurfaceSchema, bindingId: requiredId,
  }),
  get_work_item: command("get_work_item", {
    workItemId: requiredId, cursor: requiredId.optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  list_work_items: command("list_work_items", {
    projectId: requiredId, includeArchived: z.boolean().optional(),
    cursor: requiredId.optional(), limit: z.number().int().positive().max(100).optional(),
  }),
  get_work_item_runs: command("get_work_item_runs", {
    workItemId: requiredId, cursor: requiredId.optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  update_work_item_card: command("update_work_item_card", {
    requestId: workItemRequestId, workItemId: requiredId,
    expectedWorkflowRevision: z.number().int().nonnegative(), title: requiredId.optional(),
    cardPatch: kanbanCardMetadataSchema.partial(),
  }),
  move_work_item_card: command("move_work_item_card", {
    requestId: workItemRequestId, workItemId: requiredId,
    expectedWorkflowRevision: z.number().int().nonnegative(),
    columnId: requiredId, targetIndex: z.number().int().nonnegative(),
  }),
  import_kanban_board: command("import_kanban_board", {
    requestId: workItemRequestId, projectId: requiredId, projectPath: requiredId,
    migrationKey: requiredId, cards: z.array(kanbanImportCardSchema).max(5000),
  }),
  create_worktree_lineage: command("create_worktree_lineage", {
    requestId: workItemRequestId, workItemId: requiredId, targetBranch: requiredId.optional(),
  }),
  join_worktree_lineage: command("join_worktree_lineage", {
    requestId: workItemRequestId, workItemId: requiredId, lineageId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(), actor: requiredId,
  }),
  review_worktree_contribution: command("review_worktree_contribution", {
    requestId: workItemRequestId, contributionId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(), summary: requiredId,
    decision: z.enum(["approved", "rejected"]), actor: requiredId,
  }),
  enqueue_worktree_contribution: command("enqueue_worktree_contribution", {
    requestId: workItemRequestId, contributionId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(),
  }),
  retry_worktree_contribution: command("retry_worktree_contribution", {
    requestId: workItemRequestId, contributionId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(),
  }),
  discard_worktree_contribution: command("discard_worktree_contribution", {
    requestId: workItemRequestId, contributionId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(), reason: z.string().optional(),
  }),
  review_worktree_lineage: command("review_worktree_lineage", {
    requestId: workItemRequestId, lineageId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(), summary: requiredId,
    decision: z.enum(["approved", "rejected"]), actor: requiredId,
  }),
  waive_worktree_integration_gate: command("waive_worktree_integration_gate", {
    requestId: workItemRequestId, integrationScope: z.enum(["contribution", "lineage"]),
    contributionId: requiredId.optional(), lineageId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(), gateId: requiredId,
    actor: requiredId, reason: requiredId,
  }),
  resolve_worktree_conflict: command("resolve_worktree_conflict", {
    requestId: workItemRequestId, contributionId: requiredId, queueId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(),
    strategy: z.enum(["manual", "ours", "theirs"]), actor: requiredId, reason: requiredId,
  }),
  promote_worktree_lineage: command("promote_worktree_lineage", {
    requestId: workItemRequestId, lineageId: requiredId,
    expectedIntegrationRevision: z.number().int().nonnegative(),
  }),
  get_worktree_lineage_status: command("get_worktree_lineage_status", {
    lineageId: requiredId.optional(), workItemId: requiredId.optional(), runKey: requiredId.optional(),
  }),
  // Execution control
  interrupt: sessionScoped("interrupt"),
  interrupt_session: sessionScoped("interrupt_session"),
  close_session: sessionScoped("close_session"),
  // Configuration control
  set_permission_mode: command("set_permission_mode", {
    sessionKey,
    permissionMode: z.string().optional(),
  }),
  set_model: command("set_model", {
    sessionKey,
    model: z.string().optional(),
  }),
  // Task control
  stop_task: command("stop_task", {
    sessionKey,
    taskId: z.string().optional(),
  }),
  // Worktree control
  merge_worktree: sessionScoped("merge_worktree"),
  discard_worktree: sessionScoped("discard_worktree"),
  get_worktree_diff: sessionScoped("get_worktree_diff"),
  approve_changes: sessionScoped("approve_changes"),
  force_merge: sessionScoped("force_merge"),
  theirs_merge: sessionScoped("theirs_merge"),
  retry_merge: sessionScoped("retry_merge"),
  remove_session: sessionScoped("remove_session"),
  // File & state control
  rewind_files: command("rewind_files", {
    sessionKey,
    userMessageId: z.string().optional(),
    dryRun: z.boolean().optional(),
  }),
  seed_read_state: command("seed_read_state", {
    sessionKey,
    path: z.string().optional(),
    mtime: z.number().optional(),
  }),
  // Info queries
  get_context_usage: sessionScoped("get_context_usage"),
  get_usage_report: sessionScoped("get_usage_report"),
  get_provider_usage_report: command("get_provider_usage_report", {
    harness: z.string().optional(),
  }),
  get_supported_models: sessionScoped("get_supported_models"),
  get_supported_commands: sessionScoped("get_supported_commands"),
  get_supported_agents: sessionScoped("get_supported_agents"),
  get_account_info: sessionScoped("get_account_info"),
  get_mcp_server_status: sessionScoped("get_mcp_server_status"),
  get_system_model_status: sessionScoped("get_system_model_status"),
  get_system_graph: sessionScoped("get_system_graph"),
  get_work_packets: command("get_work_packets", {
    sessionKey,
    projectPath: z.string().optional(),
    workPacketId: z.string().optional(),
  }),
  waive_review_gate: command("waive_review_gate", {
    sessionKey: z.string(),
    gateId: z.string().min(1),
    reason: z.string().min(1),
  }),
  // MCP server control
  reconnect_mcp_server: command("reconnect_mcp_server", {
    sessionKey,
    serverName: z.string().optional(),
  }),
  toggle_mcp_server: command("toggle_mcp_server", {
    sessionKey,
    serverName: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  // Render-DSL interactive components
  submit_form: command("submit_form", {
    sessionKey,
    formComponentId: z.string().optional(),
    formAnswers: z.record(z.string(), z.unknown()).optional(),
  }),
  // Session history
  clear_session: sessionScoped("clear_session"),
} satisfies Record<WsCommandType, z.ZodType>;

// ── Validation entry point ─────────────────────────────────

export type WsCommandValidation =
  | { ok: true; cmd: WsCommand }
  | { ok: false; error: string };

/**
 * Validate a decoded (but untyped) inbound message against the schema for
 * its command type. Returns the original envelope on success — schemas here
 * are a gate, not a transform, so handlers see exactly what the client sent.
 */
export function validateWsCommand(raw: unknown): WsCommandValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Command must be a JSON object" };
  }
  const type = (raw as Record<string, unknown>)["type"];
  if (typeof type !== "string") {
    return { ok: false, error: 'Command requires a string "type" field' };
  }
  if (!Object.prototype.hasOwnProperty.call(COMMAND_SCHEMAS, type)) {
    return { ok: false, error: `Unknown command type: ${type}` };
  }
  const schema: z.ZodType = COMMAND_SCHEMAS[type as WsCommandType];
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid "${type}" command: ${z.prettifyError(result.error)}`,
    };
  }
  return { ok: true, cmd: raw as WsCommand };
}
