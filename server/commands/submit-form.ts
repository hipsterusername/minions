/**
 * submit_form — inject a user-submitted form's answers back into the session.
 *
 * The handler accepts only a pending form from the host's authoritative
 * render tree, persists its answers, publishes the convergent dashboard and
 * resolved review lifecycle, then resumes the same leader run.
 *
 * `formComponentId` and `formAnswers` are declared on `WsCommand` in
 * `./types.ts`, so the handler reads them directly off `cmd`.
 */

import { unicastGlobal, unicastToSession } from "../bus.ts";
import { randomUUID } from "node:crypto";
import {
  findFormById,
  type FormComponent,
} from "../../shared/render-dsl.ts";
import { persistRenderState } from "../session-persist.ts";
import {
  beginRun,
  commitReviewLifecycle,
  incrementDashboardRevision,
} from "../session-review-lifecycle.ts";
import { WorkItemServiceError } from "../work-item-service.ts";
import { sendControlError } from "./helpers.ts";
import type { CommandHandler } from "./types.ts";
import type { SessionHost } from "../session-host.ts";

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

function rejectForm(
  ws: Parameters<CommandHandler>[2],
  sessionKey: string,
  requestId: string | undefined,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  sendControlError(ws, "submit_form", sessionKey, requestId, message, {
    code,
    ...data,
  });
}

function publishAcceptedForm(
  ctx: Parameters<CommandHandler>[0],
  host: SessionHost,
): void {
  const renderState = host.renderState!;
  persistRenderState(host.id, renderState);
  ctx.bus.emitToSession(host.id, {
    type: "render_update",
    leaderSessionKey: host.id,
    action: "set",
    layout: renderState.layout,
    components: renderState.components,
  });

  const revised = incrementDashboardRevision(host.reviewLifecycle);
  const resolved = revised.reviewState === "decision_needed"
    ? beginRun(revised)
    : revised;
  commitReviewLifecycle(host, ctx.bus, resolved);
}

async function resumeCanonicalForm(
  ctx: Parameters<CommandHandler>[0],
  cmd: Parameters<CommandHandler>[1],
  ws: Parameters<CommandHandler>[2],
  host: SessionHost,
  form: FormComponent,
  answers: Record<string, unknown>,
  prompt: string,
): Promise<void> {
  const service = ctx.workItems;
  if (!service || !host.workItemId) {
    rejectForm(
      ws,
      host.id,
      cmd.requestId,
      "WORK_ITEM_COMMAND_REQUIRED",
      "Canonical work-item service is unavailable",
    );
    return;
  }

  try {
    const detail = await service.get(host.workItemId);
    const item = detail?.workItem;
    if (
      !item ||
      item.lifecycle.runtimeState !== "waiting" ||
      item.waitKind !== "decision" ||
      !item.currentRunKey ||
      item.currentRunKey !== host.runKey
    ) {
      rejectForm(
        ws,
        host.id,
        cmd.requestId,
        "WORK_ITEM_NOT_WAITING_FOR_DECISION",
        "Canonical work item is not waiting for a decision",
        { latest: detail ?? null },
      );
      return;
    }

    form.submittedAnswers = answers;
    try {
      await service.replyToWaitingRun({
        requestId: cmd.requestId ?? randomUUID(),
        workItemId: item.id,
        runKey: item.currentRunKey,
        prompt,
        expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
        expectedCurrentRunKey: item.currentRunKey,
      });
    } catch (error) {
      delete form.submittedAnswers;
      throw error;
    }
    publishAcceptedForm(ctx, host);
  } catch (error) {
    const typed = error instanceof WorkItemServiceError ? error : null;
    rejectForm(
      ws,
      host.id,
      cmd.requestId,
      typed?.code ?? "WORK_ITEM_CONTINUATION_FAILED",
      typed?.message ??
        (error instanceof Error
          ? error.message
          : "Canonical form continuation failed"),
      { latest: typed?.latest ?? null },
    );
  }
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

  const form = host.renderState
    ? findFormById(host.renderState.components, cmd.formComponentId)
    : undefined;
  if (!form) {
    rejectForm(
      ws,
      cmd.sessionKey,
      cmd.requestId,
      "FORM_NOT_FOUND",
      `Form ${cmd.formComponentId} is not pending in this session`,
    );
    return;
  }
  if (form.submittedAnswers != null) {
    rejectForm(
      ws,
      cmd.sessionKey,
      cmd.requestId,
      "FORM_ALREADY_SUBMITTED",
      `Form ${cmd.formComponentId} has already been submitted`,
    );
    return;
  }

  const answers = { ...cmd.formAnswers };
  const prompt = buildFormPrompt(cmd.formComponentId, answers);
  if (host.workItemId) {
    void resumeCanonicalForm(ctx, cmd, ws, host, form, answers, prompt);
    return;
  }

  form.submittedAnswers = answers;
  publishAcceptedForm(ctx, host);
  ctx.registry.start({
    sessionKey: cmd.sessionKey,
    invocationKind: "resume_open_run",
    prompt,
    cwd: host.cwd,
    resumeId: host.sessionId ?? undefined,
    systemPrompt: undefined,
    role: host.role,
    thinkingConfig: host.thinkingConfig,
    harness: host.harnessName,
  });
};
