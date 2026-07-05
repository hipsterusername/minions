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
import type { SessionRole } from "../session-host.ts";
import type { WsCommand, WsCommandType } from "./types.ts";

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
    cwd,
    role: z.enum(SESSION_ROLES).optional(),
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
