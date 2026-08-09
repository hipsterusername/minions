import { unicastGlobal, unicastToWorkItem } from "../bus.ts";
import { z } from "zod/v4";
import {
  workItemDetailSnapshotSchema,
  workItemListSnapshotSchema,
  workItemRunListSnapshotSchema,
  workItemServiceErrorSchema,
} from "../../shared/work-item-contracts.ts";
import { WorkItemServiceError } from "../work-item-service.ts";
import type { CommandHandler, WsCommand } from "./types.ts";
import { randomUUID } from "node:crypto";
import { serverLogger } from "../logging.ts";

const log = serverLogger.child("work-item-command");

function send(ws: Parameters<CommandHandler>[2], cmd: WsCommand, payload: Record<string, unknown>): void {
  if (cmd.workItemId) unicastToWorkItem(ws, cmd.workItemId, payload as { type: string } & Record<string, unknown>);
  else unicastGlobal(ws, payload as { type: string } & Record<string, unknown>);
}

function unavailable(cmd: WsCommand, ws: Parameters<CommandHandler>[2]): void {
  const payload = {
    type: "work_item_response",
    command: cmd.type,
    requestId: cmd.requestId ?? null,
    success: false,
    error: "Work-item service is unavailable",
    code: "unavailable",
    latest: null,
  };
  send(ws, cmd, payload);
}

function existingMutationContext(cmd: WsCommand): {
  requestId: string;
  expectedLifecycleRevision: number;
  expectedCurrentRunKey: string | null;
} {
  return {
    requestId: cmd.requestId!,
    expectedLifecycleRevision: cmd.expectedLifecycleRevision!,
    expectedCurrentRunKey: cmd.expectedCurrentRunKey!,
  };
}

function resultSchema(cmd: WsCommand): z.ZodType {
  if (cmd.type === "list_work_items") return workItemListSnapshotSchema;
  if (cmd.type === "get_work_item_runs") return workItemRunListSnapshotSchema;
  if (cmd.type === "get_work_item") return workItemDetailSnapshotSchema.nullable();
  return workItemDetailSnapshotSchema;
}

function reply(ws: Parameters<CommandHandler>[2], cmd: WsCommand, rawResult: unknown): void {
  const result = resultSchema(cmd).parse(rawResult);
  const payload = {
    type: "work_item_response",
    command: cmd.type,
    requestId: cmd.requestId ?? null,
    success: true,
    result,
  };
  send(ws, cmd, payload);
}

function fail(ws: Parameters<CommandHandler>[2], cmd: WsCommand, error: unknown): void {
  const correlationId = randomUUID();
  const candidate = error instanceof WorkItemServiceError
    ? workItemServiceErrorSchema.safeParse({
        code: error.code, message: error.message, latest: error.latest,
      })
    : null;
  const typed = candidate?.success ? candidate.data : null;
  // Never forward a raw, untyped Error's message to the client — it can
  // carry internal details (query text, file paths). Typed
  // WorkItemServiceError messages are already vetted for client display, and
  // a ZodError means the server produced a malformed result — surfacing it
  // is a debugging aid, not a leak of caller-supplied data. Anything else is
  // logged server-side and reported generically.
  const message = typed?.message
    ?? (error instanceof z.ZodError ? error.message : "Work-item command failed");
  log.error("command_failed", {
    correlationId, command: cmd.type, requestId: cmd.requestId ?? null,
    workItemId: cmd.workItemId ?? null, code: typed?.code ?? "internal", error,
  });
  send(ws, cmd, {
    type: "work_item_response",
    command: cmd.type,
    requestId: cmd.requestId ?? null,
    success: false,
    error: message,
    code: typed?.code ?? "internal",
    latest: typed?.latest ?? null,
    correlationId,
  });
}

export const workItemCommand: CommandHandler = async (ctx, cmd, ws) => {
  const service = ctx.workItems;
  if (!service) return unavailable(cmd, ws);
  try {
    let result: unknown;
    switch (cmd.type) {
    case "create_work_item": {
      const modern = cmd.workspaceId
        ? ctx.resolveWorkItemWorkspace?.(cmd.workspaceId)
        : null;
      const projectPath = modern?.projectPath
        ?? ctx.resolveWorkItemProject?.(cmd.projectId!, cmd.projectPath!);
      const projectId = modern?.projectId ?? cmd.projectId;
      if (!projectPath || !projectId) throw new WorkItemServiceError(
        "validation_failed",
        cmd.workspaceId
          ? "Workspace is not registered"
          : "Project path is not registered or does not own projectId",
      );
      result = await service.create({
        requestId: cmd.requestId!,
        projectId, projectPath, title: cmd.title!,
        changeMode: cmd.changeMode!,
      });
      break;
    }
    case "continue_work_item":
      result = await service.continue({ ...existingMutationContext(cmd),
        workItemId: cmd.workItemId!, prompt: cmd.prompt!,
        ...(cmd.displayPrompt !== undefined ? { displayPrompt: cmd.displayPrompt } : {}),
        ...(cmd.harness !== undefined ? { harness: cmd.harness } : {}),
        ...(cmd.model !== undefined ? { model: cmd.model } : {}),
        ...(cmd.permissionMode !== undefined ? { permissionMode: cmd.permissionMode } : {}),
        ...(cmd.sandboxPolicy !== undefined ? { sandboxPolicy: cmd.sandboxPolicy } : {}),
        ...(cmd.thinkingConfig !== undefined ? { thinkingConfig: cmd.thinkingConfig } : {}),
        ...(cmd.skillIds !== undefined ? { skillIds: cmd.skillIds } : {}),
        ...(cmd.skillValues !== undefined ? { skillValues: cmd.skillValues } : {}),
        ...(cmd.systemPrompt !== undefined ? { systemPrompt: cmd.systemPrompt } : {}),
        ...(cmd.attachments !== undefined ? { attachments: cmd.attachments } : {}) });
      break;
    case "start_work_item_run":
      result = await service.startRun({ ...existingMutationContext(cmd),
        workItemId: cmd.workItemId!, prompt: cmd.prompt!,
        ...(cmd.displayPrompt !== undefined ? { displayPrompt: cmd.displayPrompt } : {}),
        ...(cmd.harness !== undefined ? { harness: cmd.harness } : {}),
        ...(cmd.model !== undefined ? { model: cmd.model } : {}),
        ...(cmd.permissionMode !== undefined ? { permissionMode: cmd.permissionMode } : {}),
        ...(cmd.sandboxPolicy !== undefined ? { sandboxPolicy: cmd.sandboxPolicy } : {}),
        ...(cmd.thinkingConfig !== undefined ? { thinkingConfig: cmd.thinkingConfig } : {}),
        ...(cmd.skillIds !== undefined ? { skillIds: cmd.skillIds } : {}),
        ...(cmd.skillValues !== undefined ? { skillValues: cmd.skillValues } : {}),
        ...(cmd.systemPrompt !== undefined ? { systemPrompt: cmd.systemPrompt } : {}),
        ...(cmd.attachments !== undefined ? { attachments: cmd.attachments } : {}) });
      break;
    case "reply_to_waiting_run":
      result = await service.replyToWaitingRun({ ...existingMutationContext(cmd),
        workItemId: cmd.workItemId!, runKey: cmd.runKey!, prompt: cmd.prompt!,
        ...(cmd.displayPrompt !== undefined ? { displayPrompt: cmd.displayPrompt } : {}) });
      break;
    case "review_work_item":
      result = await service.review({ ...existingMutationContext(cmd), workItemId: cmd.workItemId! });
      break;
    case "archive_work_item":
      result = await service.archive({ ...existingMutationContext(cmd), workItemId: cmd.workItemId! });
      break;
    case "restore_work_item":
      result = await service.restore({ ...existingMutationContext(cmd), workItemId: cmd.workItemId! });
      break;
    case "attach_work_item_surface":
      result = await service.attach({ ...existingMutationContext(cmd), workItemId: cmd.workItemId!, surface: cmd.surface!, bindingId: cmd.bindingId! });
      break;
    case "detach_work_item_surface":
      result = await service.detach({ ...existingMutationContext(cmd), workItemId: cmd.workItemId!, surface: cmd.surface!, bindingId: cmd.bindingId! });
      break;
    case "get_work_item":
      result = await service.get(cmd.workItemId!, cmd.cursor, cmd.limit);
      break;
    case "list_work_items":
      result = await service.list({
        projectId: cmd.projectId!,
        ...(cmd.includeArchived !== undefined ? { includeArchived: cmd.includeArchived } : {}),
        ...(cmd.cursor ? { cursor: cmd.cursor } : {}),
        ...(cmd.limit !== undefined ? { limit: cmd.limit } : {}),
      });
      if (ctx.getLiveEditAwareness) {
        const listed = result as import("../../shared/work-item-contracts.ts").WorkItemListSnapshot;
        const projectPath = listed.items[0]?.projectPath;
        if (projectPath) result = { ...listed, coordination: ctx.getLiveEditAwareness(
          projectPath, listed.items.map((item) => item.id)) };
      }
      break;
    case "get_work_item_runs":
      result = await service.getRuns({
        workItemId: cmd.workItemId!,
        ...(cmd.cursor ? { cursor: cmd.cursor } : {}),
        ...(cmd.limit !== undefined ? { limit: cmd.limit } : {}),
      });
      break;
    default:
      return;
    }
    reply(ws, cmd, result);
  } catch (error) {
    fail(ws, cmd, error);
  }
};
