import { describe, expect, it } from "vitest";
import { createPushNotifier, notificationFromEnvelope, type PushSend } from "./push-notifier.ts";
import type { Bus } from "./bus.ts";
import type { PushStore, PushSubscription } from "./push-store.ts";
import type { WsEnvelope } from "../shared/ws-envelope.ts";

function createFakeBus(): Pick<Bus, "subscribe"> & {
  emit(envelope: WsEnvelope): void;
  subscribed: boolean;
} {
  let handler: ((envelope: WsEnvelope) => void) | null = null;
  return {
    subscribed: false,
    subscribe(next) {
      handler = next;
      this.subscribed = true;
      return () => {
        handler = null;
        this.subscribed = false;
      };
    },
    emit(envelope) {
      if (!handler) throw new Error("No bus subscriber");
      handler(envelope);
    },
  };
}

function createStore(subscriptions: PushSubscription[]): PushStore & {
  removed: string[];
} {
  return {
    removed: [],
    addSubscription() {
      throw new Error("unused");
    },
    removeSubscription(endpoint) {
      this.removed.push(endpoint);
    },
    listSubscriptions() {
      return subscriptions;
    },
  };
}

const subscriptions: PushSubscription[] = [
  {
    endpoint: "https://push.example.test/a",
    keys: { p256dh: "p256dh-a", auth: "auth-a" },
  },
  {
    endpoint: "https://push.example.test/b",
    keys: { p256dh: "p256dh-b", auth: "auth-b" },
  },
];

describe("notificationFromEnvelope", () => {
  it("maps approval_requested to the mobile review URL", () => {
    expect(
      notificationFromEnvelope({
        topic: "session:s1",
        type: "approval_requested",
        sessionKey: "s1",
        summary: "Review changes",
        diff: "diff",
      }),
    ).toEqual({
      title: "Approval requested",
      body: "Review changes",
      data: {
        url: "/m?session=s1&review=1",
        kind: "approval",
        sessionKey: "s1",
      },
    });
  });

  it("maps completion and error events to the session URL", () => {
    expect(
      notificationFromEnvelope({
        topic: "session:leader",
        type: "minion_completed",
        leaderSessionKey: "leader",
        minionSessionKey: "minion",
        taskId: "task-1",
        status: "completed",
        result: "Done",
      })?.data,
    ).toEqual({
      url: "/m?session=leader",
      kind: "minion_done",
      sessionKey: "leader",
    });

    expect(
      notificationFromEnvelope({
        topic: "session:s1",
        type: "session_error",
        sessionKey: "s1",
        error: "Boom",
      })?.data,
    ).toEqual({
      url: "/m?session=s1",
      kind: "error",
      sessionKey: "s1",
    });
  });
});

describe("createPushNotifier", () => {
  it("sends approval notifications to each stored subscription", async () => {
    const bus = createFakeBus();
    const store = createStore(subscriptions);
    const sent: Array<{ subscription: PushSubscription; payload: unknown }> = [];
    const send: PushSend = async (subscription, payloadBuffer) => {
      sent.push({
        subscription,
        payload: JSON.parse(payloadBuffer.toString()) as unknown,
      });
      return { statusCode: 201 };
    };

    const unsubscribe = createPushNotifier({
      bus,
      store,
      vapid: { publicKey: "public", privateKey: "private" },
      send,
    });
    bus.emit({
      topic: "session:s1",
      type: "approval_requested",
      sessionKey: "s1",
      summary: "Review me",
      diff: "diff",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toHaveLength(2);
    expect(sent.map((entry) => entry.subscription.endpoint)).toEqual([
      "https://push.example.test/a",
      "https://push.example.test/b",
    ]);
    expect(sent[0]?.payload).toMatchObject({
      title: "Approval requested",
      data: { url: "/m?session=s1&review=1", kind: "approval", sessionKey: "s1" },
    });
    unsubscribe();
    expect(bus.subscribed).toBe(false);
  });

  it("prunes subscriptions that return 410 Gone", async () => {
    const bus = createFakeBus();
    const store = createStore(subscriptions);
    const send: PushSend = async (subscription) => ({
      statusCode: subscription.endpoint.endsWith("/a") ? 410 : 201,
    });

    createPushNotifier({
      bus,
      store,
      vapid: { publicKey: "public", privateKey: "private" },
      send,
    });
    bus.emit({
      topic: "session:s1",
      type: "session_error",
      sessionKey: "s1",
      error: "Boom",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.removed).toEqual(["https://push.example.test/a"]);
  });
});
