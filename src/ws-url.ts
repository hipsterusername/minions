/**
 * Build the WebSocket URL for the Minions backend from the page origin.
 *
 * The frontend is always served by Vite (dev, or `vite preview` for a built
 * app), which proxies both `/api` and `/ws` to the backend on port 3141. By
 * connecting *same-origin* to `/ws` — rather than hardcoding the backend port —
 * a single HTTPS front can proxy both the app and the socket. That is exactly
 * what `tailscale serve` needs: it terminates TLS on :443 with a real `*.ts.net`
 * certificate and forwards to the local Vite port, giving the mobile PWA the
 * secure context Web Push requires. Hardcoding `:3141` would force the client to
 * open `wss://host:3141`, a port no HTTPS front exposes.
 *
 * The `location` argument defaults to `window.location` but is injectable so the
 * derivation can be unit-tested without mutating global browser state.
 */
export function buildWsUrl(
  location: Pick<Location, "protocol" | "host"> = window.location,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}
