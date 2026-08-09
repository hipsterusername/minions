import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "./db.ts";
import { createPushStore } from "./push-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createPushStore", () => {
  it("upserts, orders, and removes subscriptions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-store-"));
    dirs.push(dir);
    const db = initDb(path.join(dir, "push.db"));
    const store = createPushStore(db);
    store.addSubscription({ endpoint: "https://push.test/a", keys: { p256dh: "p1", auth: "a1" } });
    store.addSubscription({ endpoint: "https://push.test/b", keys: { p256dh: "p2", auth: "a2" } });
    store.addSubscription({ endpoint: "https://push.test/a", keys: { p256dh: "updated", auth: "updated" } });

    expect(store.listSubscriptions()).toEqual([
      { endpoint: "https://push.test/a", keys: { p256dh: "updated", auth: "updated" } },
      { endpoint: "https://push.test/b", keys: { p256dh: "p2", auth: "a2" } },
    ]);
    store.removeSubscription("https://push.test/a");
    expect(store.listSubscriptions().map((entry) => entry.endpoint)).toEqual(["https://push.test/b"]);
    db.close();
  });
});
