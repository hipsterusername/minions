/**
 * submit_form — inject a user-submitted form's answers back into the session.
 *
 * Pattern mirrors `send-message.ts`. The handler builds a synthetic user
 * turn that carries the form component ID and a structured JSON object of
 * submitted answers, then resumes the leader session with that turn.
 *
 * `formComponentId` and `formAnswers` are declared on `WsCommand` in
 * `./types.ts`, so the handler reads them directly off `cmd`.
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import type { CommandHandler } from "./types.ts";

// ── Synthetic prompt builder ──────────────────────────────

function buildFormPrompt(
  formComponentId: string,
  answers: Record<string, unknown>,
): string {
  // Compact JSON — this string lands in the model's context as a user turn,
  // where pretty-print indentation roughly doubles its token cost.
  const body = JSON.stringify(answers);
  return (
    `[The user submitted form '${formComponentId}' with the following answers:]\n\n${body}`
  );
}

// ── Handler ───────────────────────────────────────────────

export const submitForm: CommandHandler = (ctx, cmd, ws) => {
  if (!cmd.sessionKey) {
    unicastGlobal(ws, { type: "error", message: "sessionKey required" });
    return;
  }

  if (!cmd.formComponentId) {
    unicastToSession(ws, cmd.sessionKey, {
      type: "error",
      message: "formComponentId required",
    });
    return;
  }

  if (
    cmd.formAnswers == null ||
    typeof cmd.formAnswers !== "object" ||
    Array.isArray(cmd.formAnswers)
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

  const prompt = buildFormPrompt(cmd.formComponentId, cmd.formAnswers);

  ctx.registry.start({
    sessionKey: cmd.sessionKey,
    invocationKind: "resume_open_run",
    prompt,
    cwd: host.cwd,
    resumeId: host.sessionId ?? undefined,
    systemPrompt: undefined,
    role: host.role,
    thinkingConfig: host.thinkingConfig,
  });
};
