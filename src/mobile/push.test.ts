import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAuthToken } from "../api.ts";
import { enablePush, isPushSupported, urlBase64ToUint8Array } from "./push.ts";

const vapidVector = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A";

afterEach(() => {
  clearAuthToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("push helpers", () => {
  it("decodes base64url VAPID keys into bytes", () => {
    const decoded = urlBase64ToUint8Array(vapidVector);

    expect(Array.from(decoded)).toEqual(Array.from({ length: 65 }, (_, index) => index));
  });

  it("reports unsupported without browser push globals", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    expect(isPushSupported()).toBe(false);
  });

  it("reports supported when service workers, PushManager, and Notification exist", () => {
    vi.stubGlobal("window", {
      PushManager: function PushManager() {},
      Notification: { permission: "default" },
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {},
    });

    expect(isPushSupported()).toBe(true);
  });

  it("subscribes and posts the push subscription body", async () => {
    const subscribe = vi.fn<PushManager["subscribe"]>(async () => ({
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: null },
      getKey: () => null,
      toJSON: () => ({
        endpoint: "https://push.example/subscription",
        keys: {
          p256dh: "p256dh-key",
          auth: "auth-key",
        },
      }),
      unsubscribe: async () => true,
    }));
    const registration = {
      pushManager: {
        subscribe,
        getSubscription: vi.fn(async () => null),
        permissionState: vi.fn(async () => "granted" as PermissionState),
      },
    } satisfies Pick<ServiceWorkerRegistration, "pushManager">;
    const register = vi.fn<ServiceWorkerContainer["register"]>(
      async () => registration as unknown as ServiceWorkerRegistration,
    );
    const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === "/api/auth/token") {
        return new Response(JSON.stringify({ token: "auth-token" }), { status: 200 });
      }
      if (input === "/api/push/public-key") {
        return new Response(JSON.stringify({ publicKey: "AQIDBA" }), { status: 200 });
      }
      if (input === "/api/push/subscribe") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("window", {
      PushManager: function PushManager() {},
      Notification: { permission: "default", requestPermission },
    });
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register,
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(enablePush()).resolves.toBe("subscribed");

    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3, 4]),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/subscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          endpoint: "https://push.example/subscription",
          keys: {
            p256dh: "p256dh-key",
            auth: "auth-key",
          },
        }),
      }),
    );
  });
});
