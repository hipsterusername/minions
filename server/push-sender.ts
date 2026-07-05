import { buildVapidAuthHeader, encryptPayload, signVapidJwt, type VapidKeys } from "./push-crypto.ts";
import type { PushSubscription } from "./push-store.ts";

const DEFAULT_VAPID_SUBJECT = "mailto:minions@example.invalid";

export async function sendWebPush(
  subscription: PushSubscription,
  payloadBuffer: Buffer,
  vapid: VapidKeys,
): Promise<{ statusCode: number }> {
  const encrypted = encryptPayload({
    payload: payloadBuffer,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  });
  const audience = new URL(subscription.endpoint).origin;
  const jwt = signVapidJwt({
    audience,
    subject: DEFAULT_VAPID_SUBJECT,
    privateKey: vapid.privateKey,
    expSeconds: 12 * 60 * 60,
  });

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      "Content-Length": String(encrypted.length),
      Authorization: buildVapidAuthHeader(jwt, vapid.publicKey),
    },
    body: new Uint8Array(encrypted),
  });
  return { statusCode: response.status };
}
