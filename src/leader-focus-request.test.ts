import { afterEach, describe, expect, it } from "vitest";
import {
  consumeLeaderInputFocus,
  requestLeaderInputFocus,
  resetLeaderInputFocusRequestsForTests,
} from "./leader-focus-request.ts";

afterEach(() => {
  resetLeaderInputFocusRequestsForTests();
});

describe("leader-focus-request", () => {
  it("returns false when no focus was requested for the node", () => {
    expect(consumeLeaderInputFocus("node-1")).toBe(false);
  });

  it("returns true once after a request, then false (one-shot)", () => {
    requestLeaderInputFocus("node-1");
    expect(consumeLeaderInputFocus("node-1")).toBe(true);
    expect(consumeLeaderInputFocus("node-1")).toBe(false);
  });

  it("scopes requests per node id", () => {
    requestLeaderInputFocus("node-a");
    expect(consumeLeaderInputFocus("node-b")).toBe(false);
    expect(consumeLeaderInputFocus("node-a")).toBe(true);
  });

  it("clears outstanding requests on reset", () => {
    requestLeaderInputFocus("node-1");
    resetLeaderInputFocusRequestsForTests();
    expect(consumeLeaderInputFocus("node-1")).toBe(false);
  });
});
