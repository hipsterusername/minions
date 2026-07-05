#!/usr/bin/env node
/**
 * Front the Minions web UI over HTTPS on your tailnet with `tailscale serve`.
 *
 * Why: the mobile companion at `/m` uses Web Push, and browsers only expose the
 * Service Worker / PushManager / Notification APIs in a *secure context* (HTTPS,
 * or localhost). Reaching the app from a phone over `http://<lan-or-tailscale>`
 * is NOT a secure context, so notifications report "unsupported". Tailscale
 * serve terminates TLS on :443 with a real `*.ts.net` certificate and proxies to
 * the local Vite port — a genuine HTTPS origin, no self-signed certs.
 *
 * The frontend (Vite dev, or `vite preview` for a built app) already proxies
 * `/api` and `/ws` to the backend on :3141, so Tailscale only needs to front the
 * single Vite port.
 *
 * Usage:
 *   node scripts/tailscale-serve.mjs [--port <n>] [--status] [--off]
 *   pnpm serve:tailscale         # front the preview build   (port 4173)
 *   pnpm serve:tailscale:dev     # front the dev server       (port 5173)
 *
 * This only starts the HTTPS front. Run the app itself separately, e.g.:
 *   pnpm start                   # backend + Vite dev  (front with :dev)
 *   pnpm build && pnpm preview   # built app on :4173  (front with serve:tailscale)
 *
 * Tailnet-only by design. It does NOT enable `tailscale funnel` (public
 * internet); the server's origin allow-list is scoped to loopback + `*.ts.net`.
 */

import { spawnSync } from "node:child_process";

const DEFAULT_PORT = "4173";

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, mode: "serve" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--off") args.mode = "off";
    else if (arg === "--status") args.mode = "status";
    else if (arg === "--port") {
      args.port = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--port=")) {
      args.port = arg.slice("--port=".length);
    }
  }
  return args;
}

function hasTailscale() {
  const probe = spawnSync("tailscale", ["version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

function run(tsArgs) {
  const result = spawnSync("tailscale", tsArgs, { stdio: "inherit" });
  return !result.error && result.status === 0;
}

/** Best-effort read of this node's MagicDNS name for a friendly final URL. */
function magicDnsName() {
  const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  try {
    const dns = JSON.parse(result.stdout)?.Self?.DNSName;
    return typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

function main() {
  const { port, mode } = parseArgs(process.argv.slice(2));

  if (!hasTailscale()) {
    console.error(
      [
        "tailscale CLI not found on PATH.",
        "Install it from https://tailscale.com/download and run `tailscale up`,",
        "then re-run this script.",
      ].join("\n"),
    );
    process.exit(1);
  }

  if (mode === "status") {
    run(["serve", "status"]);
    return;
  }

  if (mode === "off") {
    console.log("Tearing down Tailscale serve config…");
    // `reset` clears the serve config for this node so the HTTPS front stops.
    const ok = run(["serve", "reset"]);
    process.exit(ok ? 0 : 1);
  }

  if (!/^\d+$/.test(port ?? "")) {
    console.error(`Invalid --port value: ${String(port)}`);
    process.exit(1);
  }

  console.log(`Fronting http://127.0.0.1:${port} over tailnet HTTPS (:443)…`);
  // --bg registers the proxy and returns instead of blocking the terminal.
  const ok = run(["serve", "--bg", `http://127.0.0.1:${port}`]);
  if (!ok) {
    console.error(
      "`tailscale serve` failed. Ensure you are logged in (`tailscale up`) and that\n" +
        "HTTPS certificates are enabled for your tailnet (Admin console → DNS → HTTPS).",
    );
    process.exit(1);
  }

  const host = magicDnsName();
  console.log("\nDone. The app is now served over HTTPS on your tailnet.");
  if (host) {
    console.log(`  Desktop:  https://${host}/`);
    console.log(`  Mobile:   https://${host}/m`);
  } else {
    console.log("  Open https://<your-machine>.<tailnet>.ts.net/ (mobile: append /m).");
  }
  console.log("\nStop fronting with:  node scripts/tailscale-serve.mjs --off");
}

main();
