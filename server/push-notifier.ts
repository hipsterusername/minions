import type { Bus } from "./bus.ts";
import type { VapidKeys } from "./push-crypto.ts";
import type { PushStore, PushSubscription } from "./push-store.ts";
import type { WsEnvelope } from "../shared/ws-envelope.ts";
import { serverLogger } from "./logging.ts";

const log = serverLogger.child("push");

export type PushKind = "approval" | "minion_done" | "error";

export interface PushNotificationPayload {
  title: string;
  body: string;
  data: {
    url: string;
    kind: PushKind;
    sessionKey: string;
  };
}

export type PushSend = (
  subscription: PushSubscription,
  payloadBuffer: Buffer,
  vapid: VapidKeys,
) => Promise<{ statusCode: number }>;

export function createPushNotifier({
  bus,
  store,
  vapid,
  send,
}: {
  bus: Pick<Bus, "subscribe">;
  store: PushStore;
  vapid: VapidKeys;
  send: PushSend;
}): () => void {
  return bus.subscribe((envelope) => {
    const notification = notificationFromEnvelope(envelope);
    if (!notification) return;
    void notifySubscriptions({ notification, store, vapid, send });
  });
}

export function notificationFromEnvelope(
  envelope: WsEnvelope,
): PushNotificationPayload | null {
  if (envelope.type === "approval_requested") {
    const sessionKey = stringField(envelope, "sessionKey");
    if (!sessionKey) return null;
    const summary = stringField(envelope, "summary");
    return {
      title: "Approval requested",
      body: summary || "A session is waiting for review.",
      data: {
        url: `/m?session=${encodeURIComponent(sessionKey)}&review=1`,
        kind: "approval",
        sessionKey,
      },
    };
  }

  if (envelope.type === "minion_completed") {
    const sessionKey = stringField(envelope, "leaderSessionKey");
    if (!sessionKey) return null;
    const status = stringField(envelope, "status");
    const taskId = stringField(envelope, "taskId");
    const result = stringField(envelope, "result");
    return {
      title: status === "failed" ? "Minion failed" : "Minion completed",
      body: result || (taskId ? `Task ${taskId} ${status || "finished"}.` : "A minion finished."),
      data: {
        url: `/m?session=${encodeURIComponent(sessionKey)}`,
        kind: "minion_done",
        sessionKey,
      },
    };
  }

  if (envelope.type === "session_error") {
    const sessionKey = stringField(envelope, "sessionKey");
    if (!sessionKey) return null;
    const error = stringField(envelope, "error");
    return {
      title: "Session error",
      body: error || "A session reported an error.",
      data: {
        url: `/m?session=${encodeURIComponent(sessionKey)}`,
        kind: "error",
        sessionKey,
      },
    };
  }

  return null;
}

async function notifySubscriptions({
  notification,
  store,
  vapid,
  send,
}: {
  notification: PushNotificationPayload;
  store: PushStore;
  vapid: VapidKeys;
  send: PushSend;
}): Promise<void> {
  const payloadBuffer = Buffer.from(JSON.stringify(notification));
  await Promise.all(
    store.listSubscriptions().map(async (subscription) => {
      try {
        const result = await send(subscription, payloadBuffer, vapid);
        if (result.statusCode === 404 || result.statusCode === 410) {
          store.removeSubscription(subscription.endpoint);
        }
      } catch (err) {
        log.warn("notification_send_failed", { error: err });
      }
    }),
  );
}

function stringField(
  envelope: WsEnvelope,
  key: string,
): string | undefined {
  const value = (envelope as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
