import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createExpressFetch } from "../../tests/harness/in-process-http.ts";
import type { PushStore, PushSubscription } from "../push-store.ts";
import { createPushRoutes } from "./push.ts";

function buildStore(): PushStore & { entries: PushSubscription[] } {
  return {
    entries: [],
    addSubscription(subscription) {
      this.entries = this.entries.filter((entry) => entry.endpoint !== subscription.endpoint);
      this.entries.push(subscription);
    },
    removeSubscription(endpoint) {
      this.entries = this.entries.filter((entry) => entry.endpoint !== endpoint);
    },
    listSubscriptions() { return this.entries; },
  };
}

describe("push routes", () => {
  let fetch: typeof globalThis.fetch;
  let store: ReturnType<typeof buildStore>;
  beforeEach(() => {
    store = buildStore();
    const app = express();
    app.use(express.json({ limit: "32kb" }));
    app.use("/api/push", createPushRoutes({ store, vapid: { publicKey: "pub", privateKey: "priv" } }));
    fetch = createExpressFetch(app as never);
  });

  it("returns the public key and subscribes/unsubscribes a valid endpoint", async () => {
    expect(await (await fetch("http://in-process.local/api/push/public-key")).json()).toEqual({ publicKey: "pub" });
    const subscription = {
      endpoint: "https://push.example.test/sub",
      keys: { p256dh: "Abc_123-", auth: "Def_456-" },
    };
    const subscribed = await fetch("http://in-process.local/api/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription),
    });
    expect(subscribed.status).toBe(200);
    expect(store.entries).toEqual([subscription]);

    const removed = await fetch("http://in-process.local/api/push/unsubscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    expect(removed.status).toBe(200);
    expect(store.entries).toEqual([]);
  });

  it.each([
    { endpoint: "http://push.example.test/sub", keys: { p256dh: "abc", auth: "def" } },
    { endpoint: "https://user:secret@push.example.test/sub", keys: { p256dh: "abc", auth: "def" } },
    { endpoint: "https://push.example.test/sub", keys: { p256dh: "not base64!", auth: "def" } },
  ])("rejects malformed or unsafe subscription %#", async (body) => {
    const response = await fetch("http://in-process.local/api/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(store.entries).toEqual([]);
  });
});
