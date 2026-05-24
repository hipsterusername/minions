/**
 * jsdom test environment setup.
 *
 * - Wires `@testing-library/jest-dom` matchers (toBeInTheDocument, etc.)
 *   into vitest's `expect`.
 * - Cleans up between tests so DOM state doesn't leak.
 *
 * Loaded automatically by vitest for the `dom` project (see vitest.config.ts).
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

if (typeof window !== "undefined" && window.localStorage === undefined) {
  const storage = createMemoryStorage();

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

afterEach(() => {
  cleanup();
});
