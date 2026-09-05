import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { subscribeSocketTopic, type SocketSubscribeLike } from "../../use-socket.ts";
import type { ContextItem } from "../../types.ts";
import { DEFAULT_THINKING_CONFIG } from "../../types.ts";
import { randomUuid } from "../../random-id.ts";
import { buildContextBlock } from "../../connected-context.ts";
import { diffContextDelivery, buildContextUpdateBlock } from "../../context-delivery.ts";
import { buildFrozenLeaderFollowUpPrompt, freezeLeaderSystemPrompt, type FrozenLeaderPrompt } from "./frozen-prompt.ts";
import { applyCanvasWorkItemSnapshot, detailFromWorkItemResponse, WorkItemCommandError } from "./work-item.ts";
import type { LeaderData } from "./types.ts";
import type { DeliveryReceipt } from "./CanvasDeliveryReceipt.tsx";
import type { useCanvasWorkItem } from "./use-canvas-work-item.ts";

type Input = Pick<ReturnType<typeof useCanvasWorkItem>, "requestWorkItem" | "sendCanonicalPrompt"> & {
  dataRef: MutableRefObject<LeaderData>;
  emitUpdate: (data: LeaderData) => void;
  socketSend: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribeLike;
  getContextForNode: (() => ContextItem[]) | undefined;
  frozenPromptRef: MutableRefObject<FrozenLeaderPrompt | null>;
};

/** Receipt state is persisted separately from the transcript rebuilt by session sync. */
export function useCanvasDelivery(options: Input) {
  const { dataRef, emitUpdate, socketSend, getContextForNode, frozenPromptRef,
    requestWorkItem, sendCanonicalPrompt, socketSubscribe } = options;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const ledgers = useRef(new Map<string, LeaderData["contextDelivery"]>());
  const retries = useRef(new Map<string, () => void>());
  const update = useCallback((id: string, receipt: DeliveryReceipt) => {
    emitUpdate({ ...dataRef.current, messageDelivery: {
      ...dataRef.current.messageDelivery, [id]: receipt,
    } });
  }, [dataRef, emitUpdate]);
  const restored = useRef(false);
  const restoredCanonical = useRef(new Set<string>());
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    for (const [id, receipt] of Object.entries(dataRef.current.messageDelivery ?? {})) {
      if ((receipt.state === "sending" || receipt.state === "unconfirmed")
        && receipt.workItemId && receipt.requestId) restoredCanonical.current.add(id);
      if (receipt.state === "sending") update(id, { ...receipt, state: "unconfirmed",
        reason: "Delivery was interrupted; waiting for a server receipt" });
    }
  }, [dataRef, update]);
  const recoverRestored = useCallback(() => {
    for (const id of restoredCanonical.current) {
      const receipt = dataRef.current.messageDelivery?.[id];
      if (receipt?.requestId && receipt.workItemId) {
        try { socketSend?.({
          type: "get_work_item_receipt", requestId: receipt.requestId, workItemId: receipt.workItemId,
        }); } catch { /* Retry the lookup on the next poll or reconnect. */ }
      }
    }
  }, [dataRef, socketSend]);
  useEffect(() => subscribeSocketTopic(socketSubscribe, "*", (raw) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    if (msg["type"] === "socket_reconnected") {
      for (const [id, receipt] of Object.entries(dataRef.current.messageDelivery ?? {})) {
        if (receipt.state === "sending") update(id, { ...receipt, state: "unconfirmed",
          reason: "Connection changed; waiting for a server receipt" });
      }
      recoverRestored();
      return;
    }
    if (msg["type"] === "work_item_response") {
      for (const id of restoredCanonical.current) {
        const receipt = dataRef.current.messageDelivery?.[id];
        if (!receipt || receipt.requestId !== msg["requestId"]) continue;
        const detail = detailFromWorkItemResponse(msg);
        if (detail && detail.workItem.id !== receipt.workItemId) continue;
        restoredCanonical.current.delete(id);
        if (detail) emitUpdate(applyCanvasWorkItemSnapshot(dataRef.current, detail.workItem));
        update(id, { ...receipt, state: detail ? "accepted" : "failed",
          reason: detail ? "Accepted by server" : typeof msg["error"] === "string"
            ? msg["error"] : "Server rejected this message" });
      }
      return;
    }
    if (msg["type"] !== "control_response" || msg["command"] !== "send_message"
      || typeof msg["success"] !== "boolean") return;
    for (const [id, receipt] of Object.entries(dataRef.current.messageDelivery ?? {})) {
      if (!receipt.requestId || receipt.requestId !== msg["requestId"]
        || receipt.sessionKey !== msg["sessionKey"]
        || (receipt.state !== "sending" && receipt.state !== "unconfirmed")) continue;
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      const ledger = ledgers.current.get(id);
      if (msg["success"] && ledger) emitUpdate({ ...dataRef.current, contextDelivery: ledger });
      ledgers.current.delete(id);
      update(id, { ...receipt, state: msg["success"] ? "accepted" : "failed",
        reason: msg["success"] ? "Accepted by server" : typeof msg["error"] === "string"
          ? msg["error"] : "Server rejected this message" });
    }
  }), [socketSubscribe, dataRef, emitUpdate, update, recoverRestored]);
  useEffect(() => {
    if (restoredCanonical.current.size === 0) return;
    recoverRestored();
    const timer = setInterval(recoverRestored, 15_000);
    return () => clearInterval(timer);
  }, [recoverRestored]);
  useEffect(() => {
    const activeTimers = timers.current;
    return () => { for (const timer of activeTimers.values()) clearTimeout(timer); };
  }, []);
  const send = useCallback((text: string, promptContextItems: ContextItem[] = []) => {
    const current = dataRef.current;
    if (!socketSend || !text.trim() || !current.sessionKey) return false;
    // An uncertain send can still be in the socket's reconnect queue. Never replay it.
    if (Object.values(current.messageDelivery ?? {}).some((receipt) =>
      receipt.state === "sending" || (receipt.state === "unconfirmed" && receipt.text.trim() === text.trim()))) return false;
    const id = randomUuid();
    const contextItems = getContextForNode?.() ?? [];
    const attachments = [...contextItems, ...promptContextItems].flatMap((item) => item.attachments ?? []);
    const { newItems, updates, nextLedger } = diffContextDelivery(
      contextItems, current.contextDelivery ?? {}, Date.now());
    const prompt = [buildContextUpdateBlock(updates), buildContextBlock([...newItems, ...promptContextItems]), text]
      .filter(Boolean).join("\n\n");
    const frozen = frozenPromptRef.current ?? freezeLeaderSystemPrompt({
      skillIds: current.skillIds ?? [], skillValues: current.skillValues ?? {},
      systemPromptPrefix: current.systemPromptPrefix,
      orchestrationMode: current.orchestrationMode ?? "auto",
    });
    frozenPromptRef.current = frozen;
    const followUp = buildFrozenLeaderFollowUpPrompt({ frozen, current, prompt });
    const extras = { systemPrompt: followUp.systemPrompt,
      thinkingConfig: current.thinkingConfig ?? DEFAULT_THINKING_CONFIG,
      skillIds: current.skillIds ?? [], skillValues: current.skillValues ?? {},
      ...(attachments.length ? { attachments } : {}) };
    emitUpdate({ ...current, messages: [...current.messages,
      { id, role: "user", content: text, timestamp: Date.now() }],
      messageDelivery: { ...current.messageDelivery, [id]: { state: "sending", text } } });
    const attempt = () => {
      let submitted = false;
      update(id, { state: "sending", text });
      void (async () => {
        if (!current.workItemId && !current.workItemSnapshot) {
          const requestId = randomUuid();
          const receipt: DeliveryReceipt = { state: "sending", text, requestId, sessionKey: current.sessionKey! };
          update(id, receipt);
          ledgers.current.set(id, nextLedger);
          timers.current.set(id, setTimeout(() => {
            const latest = dataRef.current.messageDelivery?.[id];
            if (latest?.requestId === requestId && latest.state === "sending")
              update(id, { ...latest, state: "unconfirmed", reason: "Still waiting for the server receipt" });
          }, 15_000));
          submitted = true;
          socketSend({ type: "send_message", sessionKey: current.sessionKey,
            requestId, prompt: followUp.prompt, ...extras });
          return;
        }
        const snapshot = dataRef.current.workItemSnapshot ?? (await requestWorkItem({
          type: "get_work_item", requestId: randomUuid(), workItemId: current.workItemId,
        })).workItem;
        const active = snapshot.lifecycle.runtimeState === "starting"
          || snapshot.lifecycle.runtimeState === "working";
        const result = await sendCanonicalPrompt(snapshot, followUp.prompt, extras, () => {
          update(id, { ...dataRef.current.messageDelivery?.[id], state: "unconfirmed", text,
            reason: "Still waiting for the server receipt" });
        }, (requestId) => {
          submitted = true;
          update(id, { state: "sending", text, requestId, workItemId: snapshot.id });
        });
        const next = applyCanvasWorkItemSnapshot(dataRef.current, result.detail.workItem);
        emitUpdate({ ...next, sessionKey: next.currentRunKey,
          currentRunKey: next.currentRunKey,
          ...(result.outcome === "sent" ? { contextDelivery: nextLedger } : {}) });
        update(id, { text, state: result.outcome === "converged" ? "failed"
          : active && result.detail.workItem.currentRunKey === snapshot.currentRunKey
            ? "queued" : "accepted",
          ...(result.outcome === "converged" ? { reason: "Run changed before this message was accepted" } : {}) });
      })().catch((error: unknown) => {
        update(id, { ...dataRef.current.messageDelivery?.[id], text, state: !submitted || error instanceof WorkItemCommandError ? "failed" : "unconfirmed",
          reason: error instanceof Error ? error.message : String(error) });
      });
    };
    retries.current.set(id, attempt);
    attempt();
    return true;
  }, [dataRef, emitUpdate, socketSend, getContextForNode, frozenPromptRef,
    requestWorkItem, sendCanonicalPrompt, update]);
  const retry = useCallback((id: string) => {
    if (dataRef.current.messageDelivery?.[id]?.state !== "failed") return;
    if (Object.values(dataRef.current.messageDelivery ?? {}).some((r) =>
      r.state === "sending" || (r.state === "unconfirmed"
        && r.text.trim() === dataRef.current.messageDelivery?.[id]?.text.trim()))) return;
    const attempt = retries.current.get(id);
    if (attempt) attempt();
    else update(id, { ...dataRef.current.messageDelivery[id]!,
      reason: "Copy this message into the composer to retry after reload" });
  }, [dataRef, update]);
  return { send, retry, receipts: dataRef.current.messageDelivery ?? {} };
}
