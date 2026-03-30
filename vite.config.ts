import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3141",
    },
    watch: {
      // Ignore sidecar data and worktree directories so that autosave DB writes,
      // settings changes, and worktree operations don't trigger Vite full-reloads.
      ignored: [
        "**/.claude-canvas/**",
        "**/.canvas-worktrees/**",
      ],
    },
  },
})
