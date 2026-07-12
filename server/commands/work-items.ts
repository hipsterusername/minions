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
  if (cmd.type === "list_work_items" || cmd.type === "import_kanban_board") return workItemListSnapshotSchema;
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
  const candidate = error instanceof WorkItemServiceError
    ? workItemServiceErrorSchema.safeParse({
        code: error.code, message: error.message, latest: error.latest,
      })
    : null;
  const typed = candidate?.success ? candidate.data : null;
  send(ws, cmd, {
    type: "work_item_response",
    command: cmd.type,
    requestId: cmd.requestId ?? null,
    success: false,
    error: typed?.message ?? "Work-item command failed",
    code: typed?.code ?? "internal",
    latest: typed?.latest ?? null,
  });
}

export const workItemCommand: CommandHandler = async (ctx, cmd, ws) => {
  const service = ctx.workItems;
  if (!service) return unavailable(cmd, ws);
  try {
    let result: unknown;
    switch (cmd.type) {
    case "create_work_item": {
      const projectPath = ctx.resolveWorkItemProject?.(cmd.projectId!, cmd.projectPath!);
      if (!projectPath) {
        throw new WorkItemServiceError("validation_failed", "Project path is not registered or does not own projectId");
      }
      result = await service.create({
        requestId: cmd.requestId!,
        projectId: cmd.projectId!, projectPath, title: cmd.title!,
        changeMode: cmd.changeMode!,
        ...(cmd.workflowColumnId ? { workflowColumnId: cmd.workflowColumnId } : {}),
        ...(cmd.workflowRank ? { workflowRank: cmd.workflowRank } : {}),
        ...(cmd.cardPatch ? { card: cmd.cardPatch } : {}),
      });
      break;
    }
    case "start_work_item_run":
      result = await service.startRun({ ...existingMutationContext(cmd),
        workItemId: cmd.workItemId!, prompt: cmd.prompt!,
        ...(cmd.harness !== undefined ? { harness: cmd.harness } : {}),
        ...(cmd.model !== undefined ? { model: cmd.model } : {}),
        ...(cmd.permissionMode !== undefined ? { permissionMode: cmd.permissionMode } : {}),
        ...(cmd.thinkingConfig !== undefined ? { thinkingConfig: cmd.thinkingConfig } : {}),
        ...(cmd.skillIds !== undefined ? { skillIds: cmd.skillIds } : {}),
        ...(cmd.systemPrompt !== undefined ? { systemPrompt: cmd.systemPrompt } : {}),
        ...(cmd.attachments !== undefined ? { attachments: cmd.attachments } : {}) });
      break;
    case "reply_to_waiting_run":
      result = await service.replyToWaitingRun({ ...existingMutationContext(cmd), workItemId: cmd.workItemId!, runKey: cmd.runKey!, prompt: cmd.prompt! });
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
    case "update_work_item_card":
      result = await service.updateCard({ requestId: cmd.requestId!, workItemId: cmd.workItemId!,
        expectedWorkflowRevision: cmd.expectedWorkflowRevision!, patch: cmd.cardPatch!,
        ...(cmd.title !== undefined ? { title: cmd.title } : {}) });
      break;
    case "move_work_item_card":
      result = await service.moveCard({ requestId: cmd.requestId!, workItemId: cmd.workItemId!,
        expectedWorkflowRevision: cmd.expectedWorkflowRevision!, columnId: cmd.columnId!,
        targetIndex: cmd.targetIndex! });
      break;
    case "import_kanban_board": {
      const projectPath = ctx.resolveWorkItemProject?.(cmd.projectId!, cmd.projectPath!);
      if (!projectPath) throw new WorkItemServiceError("validation_failed",
        "Project path is not registered or does not own projectId");
      result = await service.importKanban({ requestId: cmd.requestId!, projectId: cmd.projectId!,
        projectPath, migrationKey: cmd.migrationKey!, cards: cmd.cards! });
      break;
    }
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
