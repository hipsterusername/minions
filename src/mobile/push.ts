import { getAuthToken } from "../api.ts";

type PushState = "subscribed" | "default" | "denied" | "unsupported";
type EnablePushResult = "subscribed" | "denied" | "unsupported";

interface PublicKeyResponse {
  publicKey: string;
}

interface PushSubscriptionBody {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function browserGlobalsAvailable(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

function notificationPermission(): NotificationPermission {
  if (!browserGlobalsAvailable() || !("Notification" in window)) return "default";
  return Notification.permission;
}

function isPushSubscriptionBody(value: PushSubscriptionJSON): value is PushSubscriptionBody {
  return (
    typeof value.endpoint === "string" &&
    value.keys !== undefined &&
    typeof value.keys["p256dh"] === "string" &&
    typeof value.keys["auth"] === "string"
  );
}

async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = `${base64}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function isPushSupported(): boolean {
  return browserGlobalsAvailable() && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!browserGlobalsAvailable() || !("serviceWorker" in navigator)) {
    return Promise.reject(new Error("Service workers are not supported."));
  }

  return navigator.serviceWorker.register("/sw.js");
}

export async function enablePush(): Promise<EnablePushResult> {
  if (!isPushSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  const registration = await registerServiceWorker();
  const { publicKey } = await authedJson<PublicKeyResponse>("/api/push/public-key");
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const body = subscription.toJSON();

  if (!isPushSubscriptionBody(body)) {
    throw new Error("Push subscription is missing endpoint or keys.");
  }

  await authedJson<{ ok: true }>("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: body.endpoint,
      keys: {
        p256dh: body.keys["p256dh"],
        auth: body.keys["auth"],
      },
    }),
  });

  return "subscribed";
}

export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  await authedJson<{ ok: true }>("/api/push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";

  const permission = notificationPermission();
  if (permission === "denied") return "denied";

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? "subscribed" : "default";
}
