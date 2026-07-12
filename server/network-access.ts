import net from "node:net";

const TAILSCALE_IPV6_PREFIX = "fd7a:115c:a1e0:";

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function normalizeAddress(address: string): string {
  const host = normalizeHost(address);
  return host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
}

function isTailscaleIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return parts[0] === 100 && parts[1] !== undefined && parts[1] >= 64 && parts[1] <= 127;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeAddress(host);
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

export function isTailscaleHost(host: string): boolean {
  const normalized = normalizeAddress(host);
  if (normalized.endsWith(".ts.net")) return true;
  if (net.isIP(normalized) === 4) return isTailscaleIpv4(normalized);
  return net.isIP(normalized) === 6 && normalized.startsWith(TAILSCALE_IPV6_PREFIX);
}

export function isAllowedDevHost(host: string): boolean {
  return isLoopbackHost(host) || isTailscaleHost(host);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  // Auth bootstrap applies its stricter origin-less policy separately. Other
  // authenticated protocol clients (notably CLI WebSocket clients) may not
  // send the browser-only Origin header.
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isAllowedDevHost(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedAuthRequestHost(hostname: string, remoteAddress?: string): boolean {
  if (!isAllowedDevHost(hostname) || !remoteAddress || !isAllowedDevHost(remoteAddress)) {
    return false;
  }
  // Loopback is a valid peer for both direct localhost traffic and the two
  // supported local proxies. A direct tailnet peer must address a tailnet
  // host; otherwise Host: localhost would be a spoofable shortcut.
  return isLoopbackHost(remoteAddress) || isTailscaleHost(hostname);
}

/**
 * Fail-closed policy for the one unauthenticated endpoint.
 *
 * A loopback peer may be either the browser itself, Vite, or Tailscale Serve.
 * Host is never inferred from the peer: both values must independently be in
 * the supported loopback/tailnet boundary. Browser requests for a tailnet host
 * must additionally carry an Origin for that same host, preventing a caller
 * from minting a token with only a spoofed Host header. Origin-less access is
 * retained solely for local command-line clients talking to a loopback host.
 */
export function isAllowedAuthBootstrapRequest(input: {
  hostname: string;
  remoteAddress?: string;
  origin?: string;
}): boolean {
  if (!isAllowedAuthRequestHost(input.hostname, input.remoteAddress)) return false;

  if (!input.origin) {
    return isLoopbackHost(input.hostname) && isLoopbackHost(input.remoteAddress ?? "");
  }

  try {
    const url = new URL(input.origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isAllowedDevHost(url.hostname)) {
      return false;
    }
    return normalizeAddress(url.hostname) === normalizeAddress(input.hostname);
  } catch {
    return false;
  }
}
