import { afterEach, describe, expect, it, vi } from "vitest";

import { randomUuid } from "./random-id.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
  vi.restoreAllMocks();
});

describe("randomUuid", () => {
  it("uses the native crypto.randomUUID when available (secure context)", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(randomUuid()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("falls back to getRandomValues when randomUUID is undefined (non-secure context)", () => {
    // Simulate http://<lan-ip> where crypto.randomUUID does not exist but
    // getRandomValues still does.
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues<T extends ArrayBufferView>(array: T): T {
          const bytes = new Uint8Array(
            array.buffer,
            array.byteOffset,
            array.byteLength,
          );
          for (let i = 0; i < bytes.length; i += 1) bytes[i] = i * 7;
          return array;
        },
      },
    });

    const id = randomUuid();
    expect(id).toMatch(UUID_V4);
    expect("randomUUID" in globalThis.crypto).toBe(false);
  });

  it("falls back to Math.random when crypto is entirely unavailable", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    expect(randomUuid()).toMatch(UUID_V4);
  });
});
