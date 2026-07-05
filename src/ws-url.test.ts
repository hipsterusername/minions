import { describe, expect, it } from "vitest";

import { buildWsUrl } from "./ws-url.ts";

describe("buildWsUrl", () => {
  it("uses ws:// for an http origin and connects same-origin to /ws", () => {
    expect(buildWsUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/ws",
    );
  });

  it("uses wss:// for an https origin (e.g. behind `tailscale serve`)", () => {
    // Tailscale serve terminates TLS on :443, so host carries no explicit port.
    expect(buildWsUrl({ protocol: "https:", host: "my-host.tailnet.ts.net" })).toBe(
      "wss://my-host.tailnet.ts.net/ws",
    );
  });

  it("preserves a non-default port carried on the host (preview build)", () => {
    expect(buildWsUrl({ protocol: "http:", host: "192.168.1.5:4173" })).toBe(
      "ws://192.168.1.5:4173/ws",
    );
  });

  it("does not hardcode the backend :3141 port", () => {
    const url = buildWsUrl({ protocol: "https:", host: "host.ts.net" });
    expect(url).not.toContain(":3141");
  });
});
