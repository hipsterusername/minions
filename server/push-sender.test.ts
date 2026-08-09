import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { base64Url } from "./push-crypto.ts";
import { createWebPushSender } from "./push-sender.ts";

function receiverKeys(): { p256dh: string; auth: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  return {
    p256dh: base64Url(Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, "base64url"),
      Buffer.from(jwk.y!, "base64url"),
    ])),
    auth: base64Url(randomBytes(16)),
  };
}

function vapidKeys() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: "public-key",
    privateKey: base64Url(pair.privateKey.export({ format: "der", type: "pkcs8" })),
  };
}

describe("createWebPushSender", () => {
  it("encrypts the payload and sends required Web Push headers", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return new Response(null, { status: 201 });
    };
    const send = createWebPushSender(fetchFn);
    await expect(send(
      { endpoint: "https://push.example.test/sub/1", keys: receiverKeys() },
      Buffer.from('{"title":"Hello"}'),
      vapidKeys(),
    )).resolves.toEqual({ statusCode: 201 });

    const { input: url, init } = requests[0]!;
    expect(String(url)).toBe("https://push.example.test/sub/1");
    expect(init).toBeDefined();
    expect(init).toMatchObject({ method: "POST" });
    const headers = init!.headers as Record<string, string>;
    expect(headers).toMatchObject({
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      Authorization: expect.stringMatching(/^vapid t=.+, k=public-key$/),
    });
    expect(Number(headers["Content-Length"])).toBeGreaterThan(0);
  });

  it("rejects non-TLS and credential-bearing endpoints before fetch", async () => {
    const fetchFn = vi.fn();
    const send = createWebPushSender(fetchFn as typeof fetch);
    await expect(send(
      { endpoint: "http://push.example.test/sub", keys: receiverKeys() },
      Buffer.from("x"),
      vapidKeys(),
    )).rejects.toThrow(/HTTPS/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
