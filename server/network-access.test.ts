import { describe, expect, it } from "vitest";
import {
  isAllowedAuthRequestHost,
  isAllowedDevHost,
  isAllowedOrigin,
  isTailscaleHost,
} from "./network-access.ts";

describe("network access allowlist", () => {
  it("allows loopback hosts", () => {
    expect(isAllowedDevHost("localhost")).toBe(true);
    expect(isAllowedDevHost("127.0.0.1")).toBe(true);
    expect(isAllowedDevHost("::1")).toBe(true);
  });

  it("allows Tailscale IPv4, IPv6, and MagicDNS hosts", () => {
    expect(isTailscaleHost("100.64.0.1")).toBe(true);
    expect(isTailscaleHost("100.127.255.254")).toBe(true);
    expect(isTailscaleHost("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailscaleHost("workstation.tailnet.ts.net")).toBe(true);
  });

  it("rejects non-Tailscale public hosts", () => {
    expect(isAllowedDevHost("100.128.0.1")).toBe(false);
    expect(isAllowedDevHost("8.8.8.8")).toBe(false);
    expect(isAllowedDevHost("example.com")).toBe(false);
  });

  it("allows browser origins from loopback and Tailscale hosts", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://100.100.100.100:5173")).toBe(true);
    expect(isAllowedOrigin("http://workstation.tailnet.ts.net:5173")).toBe(true);
  });

  it("rejects browser origins outside the dev allowlist", () => {
    expect(isAllowedOrigin("ftp://localhost")).toBe(false);
    expect(isAllowedOrigin("http://example.com:5173")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });

  it("allows auth bootstrap when Vite proxies a Tailscale request through loopback", () => {
    expect(isAllowedAuthRequestHost("workstation.tailnet.ts.net", "127.0.0.1")).toBe(true);
    expect(isAllowedAuthRequestHost("example.com", "127.0.0.1")).toBe(true);
  });
});
