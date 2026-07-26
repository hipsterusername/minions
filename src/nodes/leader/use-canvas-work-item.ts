import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { WorkItemDetailSnapshot, WorkItemSnapshot } from "../../../shared/work-item-contracts.ts";
import type { ServerMessage, SocketSubscribeLike } from "../../use-socket.ts";
import { subscribeSocketTopic } from "../../use-socket.ts";
import { DEFAULT_THINKING_CONFIG, type ContextItem } from "../../types.ts";
import type { LeaderData } from "./types.ts";
import { applyCanvasWorkItemSnapshot, canonicalPromptCommand, detailFromWorkItemResponse,
  errorFromWorkItemResponse, WorkItemCommandError } from "./work-item.ts";
import { reduceLiveEditAwareness } from "../../../shared/live-edit-coordination.ts";
import { randomUuid } from "../../random-id.ts";
import { decideConflictRecovery } from "../../work-item-retry-policy.ts";

interface Input {
  nodeId: string; projectId: string | undefined; projectPath: string | undefined;
  socketSend: ((data: unknown) => void) | undefined; socketSubscribe: SocketSubscribeLike;
  dataRef: MutableRefObject<LeaderData>;
  emitUpdate: (data: LeaderData) => void;
  publishCanvasContext: (sessionKey: string, items: ContextItem[], previous: null) => void;
}

export interface CanvasPromptResult {
  detail: WorkItemDetailSnapshot;
  outcome: "sent" | "converged";
}

export function useCanvasWorkItem(input: Input) {
  const pending = useRef(new Map<string, { resolve: (detail: WorkItemDetailSnapshot) => void;
    reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => () => {
    for (const request of pending.current.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Canvas work-item requester unmounted"));
    }
    pending.current.clear();
  }, []);
  const request = useCallback((command: Record<string, unknown>) => {
    const requestId = command["requestId"] as string;
    return new Promise<WorkItemDetailSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => { pending.current.delete(requestId);
        reject(new Error("Work-item command timed out")); }, 15_000);
      pending.current.set(requestId, { resolve, reject, timer });
      input.socketSend?.(command);
    });
  }, [input.socketSend]);

  useEffect(() => subscribeSocketTopic(input.socketSubscribe, "*", (raw: unknown) => {
    const msg = raw as ServerMessage & { requestId?: string | null; success?: boolean;
      result?: unknown; error?: string; workItem?: WorkItemSnapshot };
    if (msg.type === "work_item_response" && msg.requestId) {
      const found = pending.current.get(msg.requestId);
      if (found) {
        clearTimeout(found.timer); pending.current.delete(msg.requestId);
        const detail = detailFromWorkItemResponse(msg);
        if (detail) found.resolve(detail); else found.reject(errorFromWorkItemResponse(msg));
      }
    }
    if (msg.type === "work_item_response" && !msg.success) {
      const latest = errorFromWorkItemResponse(msg).latest?.workItem;
      if (latest && latest.id === input.dataRef.current.workItemId) {
        input.emitUpdate(applyCanvasWorkItemSnapshot(input.dataRef.current, latest));
      }
    }
    if (msg.type === "work_item_changed" && msg.workItem
      && msg.workItem.id === input.dataRef.current.workItemId) {
      input.emitUpdate(applyCanvasWorkItemSnapshot(input.dataRef.current, msg.workItem));
    }
    if (msg.type === "live_edit_coordination"
      && msg.workItemId === input.dataRef.current.workItemId) input.emitUpdate({
        ...input.dataRef.current, liveEditAwareness: reduceLiveEditAwareness(
          input.dataRef.current.liveEditAwareness, msg.event) });
  }), [input.socketSubscribe, input.emitUpdate, input.dataRef]);

  // Hydrate from the server even when a persisted snapshot exists: node data
  // survives page reloads and server restarts, so a cached snapshot can hold a
  // pre-restart lifecycle revision that the server will reject as stale. The
  // merge inside applyCanvasWorkItemSnapshot discards regressions, so a fresh
  // read is always safe.
  const hydratedItemRef = useRef<string | null>(null);
  useEffect(() => {
    const current = input.dataRef.current;
    if (!input.socketSend || !current.workItemId) return;
    if (hydratedItemRef.current === current.workItemId) return;
    hydratedItemRef.current = current.workItemId;
    void request({ type: "get_work_item", requestId: randomUuid(),
      workItemId: current.workItemId }).then(async (detail) => {
      input.emitUpdate(applyCanvasWorkItemSnapshot(input.dataRef.current, detail.workItem));
      const attached = detail.bindings.some((binding) => binding.surface === "canvas"
        && binding.bindingId === input.nodeId && binding.detachedAt === null);
      if (!attached) {
        const bound = await request({ type: "attach_work_item_surface", requestId: randomUuid(),
          workItemId: detail.workItem.id, surface: "canvas", bindingId: input.nodeId,
          expectedLifecycleRevision: detail.workItem.lifecycle.lifecycleRevision,
          expectedCurrentRunKey: detail.workItem.currentRunKey });
        input.emitUpdate(applyCanvasWorkItemSnapshot(input.dataRef.current, bound.workItem));
      }
    }).catch(() => { hydratedItemRef.current = null; /* legacy binding remains usable */ });
  }, [input.socketSend, input.dataRef.current.workItemId, input.nodeId, request, input.emitUpdate]);

  const sendCanonicalPrompt = useCallback(async (item: WorkItemSnapshot, prompt: string,
    extras: Record<string, unknown> = {}): Promise<CanvasPromptResult> => {
    let command: Record<string, unknown> = {
      ...canonicalPromptCommand(item, prompt), ...extras,
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return { detail: await request(command), outcome: "sent" };
      } catch (error) {
        if (!(error instanceof WorkItemCommandError)) throw error;
        let latest = error.latest;
        // Older peers may omit `latest`; fetching it is data acquisition only.
        // The shared policy still owns whether the refreshed state may retry.
        if (error.code === "conflict" && !latest && attempt < 3) {
          latest = await request({ type: "get_work_item", requestId: randomUuid(),
            workItemId: item.id });
        }
        if (latest && latest.workItem.id === input.dataRef.current.workItemId) {
          input.emitUpdate(applyCanvasWorkItemSnapshot(
            input.dataRef.current, latest.workItem));
        }
        const recovery = decideConflictRecovery({
          code: error.code, latest, attempt, projectId: item.projectId,
          workItemId: item.id, prompt, requestId: randomUuid(), options: extras,
        });
        if (recovery.kind === "retry") {
          command = recovery.command;
          continue;
        }
        if (recovery.kind === "converge") {
          return { detail: latest!, outcome: "converged" };
        }
        throw error;
      }
    }
    throw new Error("Work-item lifecycle changed repeatedly while starting");
  }, [request, input.emitUpdate, input.dataRef]);

  const begin = useCallback(async (run: { userPrompt: string; prompt: string;
    systemPrompt: string; attachments: unknown[]; contextItems: ContextItem[] }) => {
    if (!input.projectId || !input.projectPath) throw new Error("Canonical project identity is unavailable");
    let item = input.dataRef.current.workItemSnapshot ?? null;
    if (!item) {
      const created = await request({ type: "create_work_item", requestId: randomUuid(),
        projectId: input.projectId, projectPath: input.projectPath,
        title: input.dataRef.current.taskName?.trim() || run.userPrompt.split("\n")[0]!.slice(0, 120),
        changeMode: input.dataRef.current.worktreeIsolation ? "worktree" : "live",
        workflowColumnId: "in-progress",
        cardPatch: { leaderNodeId: input.nodeId, autoSynced: true,
          model: input.dataRef.current.model,
          ...(input.dataRef.current.harness ? { harness: input.dataRef.current.harness } : {}),
          permissionMode: input.dataRef.current.permissionMode,
          worktreeIsolation: input.dataRef.current.worktreeIsolation ?? false,
          skillIds: input.dataRef.current.skillIds ?? [],
          skillValues: input.dataRef.current.skillValues ?? {} } });
      item = created.workItem;
      input.emitUpdate(applyCanvasWorkItemSnapshot(input.dataRef.current, item));
      const attached = await request({ type: "attach_work_item_surface", requestId: randomUuid(),
        workItemId: item.id, surface: "canvas", bindingId: input.nodeId,
        expectedLifecycleRevision: item.lifecycle.lifecycleRevision,
        expectedCurrentRunKey: item.currentRunKey });
      item = attached.workItem;
      input.emitUpdate(applyCanvasWorkItemSnapshot(input.dataRef.current, item));
    }
    const promptResult = await sendCanonicalPrompt(item, run.prompt, {
      systemPrompt: run.systemPrompt, skillIds: input.dataRef.current.skillIds ?? [],
      skillValues: input.dataRef.current.skillValues ?? {},
      model: input.dataRef.current.model,
      thinkingConfig: input.dataRef.current.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      permissionMode: input.dataRef.current.permissionMode,
      ...(input.dataRef.current.harness ? { harness: input.dataRef.current.harness } : {}),
      ...(run.attachments.length > 0 ? { attachments: run.attachments } : {}) });
    const started = promptResult.detail;
    const next = applyCanvasWorkItemSnapshot(input.dataRef.current, started.workItem);
    input.emitUpdate({ ...next, sessionKey: started.workItem.currentRunKey,
      currentRunKey: started.workItem.currentRunKey });
    if (started.workItem.currentRunKey) input.publishCanvasContext(
      started.workItem.currentRunKey, run.contextItems, null);
    return started;
  }, [input.projectId, input.projectPath, input.nodeId, input.emitUpdate,
    input.publishCanvasContext, input.dataRef, request, sendCanonicalPrompt]);
  return { requestWorkItem: request, beginCanonicalRun: begin, sendCanonicalPrompt };
}
