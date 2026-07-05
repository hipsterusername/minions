import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Front the whole app on the Vite port and forward backend traffic to the
// server. Keeping /api and /ws same-origin means a single HTTPS front (e.g.
// `tailscale serve` terminating TLS on :443) can proxy both the app and the
// socket — which is what gives the mobile PWA the secure context Web Push needs.
const backendPort = process.env["PORT"] ?? "3141"
const apiProxy = {
  "/api": `http://localhost:${backendPort}`,
  "/ws": { target: `ws://localhost:${backendPort}`, ws: true },
}

const allowedHosts = [
  ".ts.net",
]

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts,
    proxy: apiProxy,
    watch: {
      // Ignore sidecar data and worktree directories so that autosave DB writes,
      // settings changes, and worktree operations don't trigger Vite full-reloads.
      ignored: [
        "**/.minions/**",
        "**/.canvas-worktrees/**",
      ],
    },
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts,
    proxy: apiProxy,
  },
})
