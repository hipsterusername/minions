import { Router } from "express";
import type { Request, Response } from "express";
import type { VapidKeys } from "../push-crypto.ts";
import type { PushStore, PushSubscription } from "../push-store.ts";

export function createPushRoutes({
  store,
  vapid,
}: {
  store: PushStore;
  vapid: VapidKeys;
}): Router {
  const router = Router();

  router.get("/public-key", (_req: Request, res: Response) => {
    res.json({ publicKey: vapid.publicKey });
  });

  router.post("/subscribe", (req: Request, res: Response) => {
    const subscription = parseSubscription(req.body);
    if (!subscription) {
      res.status(400).json({ error: "Malformed push subscription" });
      return;
    }
    store.addSubscription(subscription);
    res.json({ ok: true });
  });

  router.post("/unsubscribe", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body["endpoint"] !== "string" || !isSecurePushEndpoint(body["endpoint"])) {
      res.status(400).json({ error: "Malformed push unsubscribe request" });
      return;
    }
    store.removeSubscription(body["endpoint"]);
    res.json({ ok: true });
  });

  return router;
}

function parseSubscription(body: unknown): PushSubscription | null {
  if (!isRecord(body)) return null;
  const endpoint = body["endpoint"];
  const keys = body["keys"];
  if (typeof endpoint !== "string" || !isSecurePushEndpoint(endpoint) || !isRecord(keys)) return null;
  const p256dh = keys["p256dh"];
  const auth = keys["auth"];
  if (!isBase64Url(p256dh, 4096) || !isBase64Url(auth, 1024)) return null;

  return {
    endpoint,
    keys: { p256dh, auth },
  };
}

function isSecurePushEndpoint(raw: string): boolean {
  if (raw.length > 4096) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isBase64Url(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
