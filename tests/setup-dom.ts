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

afterEach(() => {
  cleanup();
});
