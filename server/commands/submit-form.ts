/**
 * submit_form — inject a user-submitted form's answers back into the session.
 *
 * Pattern mirrors `send-message.ts`. The handler builds a synthetic user
 * turn that carries the form component ID and a structured JSON object of
 * submitted answers, then resumes the leader session with that turn.
 *
 * The handler intentionally does NOT modify `server/commands/index.ts` or
 * `server/commands/types.ts` — the Leader wires that in.
 *
 * Extension shape for WsCommand (add fields documented below when the Leader
 * registers this handler):
 *
 * ```
 * WsCommandFormFields = {
 *   formComponentId?: string;        // id of the FormComponent the user filled
 *   formAnswers?: Record<string, unknown>; // raw answer map from FormComponent
 * }
 * ```
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import type { CommandHandler } from "./types.ts";

// ── Synthetic prompt builder ──────────────────────────────

function buildFormPrompt(
  formComponentId: string,
  answers: Record<string, unknown>,
): string {
  const body = JSON.stringify(answers, null, 2);
  return (
    `[The user submitted form '${formComponentId}' with the following answers:]\n\n${body}`
  );
}

// ── Handler ───────────────────────────────────────────────

export const submitForm: CommandHandler = (ctx, cmd, ws) => {
  // Validate required fields. `formComponentId` and `formAnswers` are
  // carry-on fields not yet declared on WsCommand — read via index access.
  const ext = cmd as typeof cmd & {
    formComponentId?: string;
    formAnswers?: Record<string, unknown>;
  };

  if (!cmd.sessionKey) {
    unicastGlobal(ws, { type: "error", message: "sessionKey required" });
    return;
  }

  if (!ext.formComponentId) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "error",
      message: "formComponentId required",
    });
    return;
  }

  if (
    ext.formAnswers == null ||
    typeof ext.formAnswers !== "object" ||
    Array.isArray(ext.formAnswers)
  ) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "error",
      message: "formAnswers must be a non-null object",
    });
    return;
  }

  const host = ctx.registry.get(cmd.sessionKey);
  if (!host) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "error",
      message: `Session ${cmd.sessionKey} not found`,
    });
    return;
  }

  const prompt = buildFormPrompt(ext.formComponentId, ext.formAnswers);

  ctx.registry.start({
    sessionKey: cmd.sessionKey,
    prompt,
    cwd: host.cwd,
    resumeId: host.sessionId ?? undefined,
    systemPrompt: undefined,
    role: host.role,
    thinkingConfig: host.thinkingConfig,
  });
};
