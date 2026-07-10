/**
 * Secure-context-safe random identifiers.
 *
 * `crypto.randomUUID()` is only defined in **secure contexts** (HTTPS or
 * `localhost`). The mobile app is often opened over plain HTTP on a LAN
 * address — e.g. `http://192.168.1.5:6173/m` on a phone — where
 * `crypto.randomUUID` is `undefined` and calling it throws a `TypeError`.
 * That previously broke leader launch (the session key was minted with
 * `crypto.randomUUID()` before `send()`, so the whole handler threw) and
 * mobile approval requests.
 *
 * `randomUuid()` prefers the native generator, then falls back to
 * `crypto.getRandomValues` (available in *all* contexts), and finally to
 * `Math.random` — always returning a valid RFC-4122 v4 UUID string.
 */
export function randomUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Set the version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
