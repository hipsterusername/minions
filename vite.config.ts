import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = {
  "/api": "http://localhost:3141",
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
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
    proxy: apiProxy,
  },
})
