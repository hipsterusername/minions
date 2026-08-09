import type Database from "better-sqlite3";

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushStore {
  addSubscription(subscription: PushSubscription): void;
  removeSubscription(endpoint: string): void;
  listSubscriptions(): PushSubscription[];
}

export function createPushStore(db: Database.Database): PushStore {
  return {
    addSubscription(subscription) {
      db.prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth`,
      ).run(
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        Date.now(),
      );
    },
    removeSubscription(endpoint) {
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    },
    listSubscriptions() {
      const rows = db
        .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at")
        .all() as PushSubscriptionRow[];
      return rows.map((row) => ({
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      }));
    },
  };
}
