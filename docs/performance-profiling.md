# Performance Profiling

Use this path to compare before/after results for React render churn during
leader streaming. Keep the app flow, browser, project, viewport size, and
recording length identical across both runs.

## Production-mode run

Run the backend and the built frontend in separate terminals:

```bash
pnpm server
```

```bash
pnpm build
pnpm preview --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173`. The preview server proxies `/api` to the backend
on `localhost:3141`; the WebSocket still connects directly to that backend.

## Flow To Record

1. Open the same project for both the baseline and after run.
2. Expand the ProjectPanel from the top-left project button.
3. Open the Dashboard tab and keep the Tree view selected, not Agents.
4. Start a Leader that streams for at least 30 seconds while reading files. A
   stable profiling prompt is:

   ```text
   Inspect src/components/ProjectTree.tsx, src/nodes/LeaderNode.tsx,
   src/components/SimpleMarkdown.tsx, and src/use-autosave.ts. Summarize
   performance hotspots you notice. Do not edit files.
   ```

5. While the Leader is actively streaming, keep the ProjectPanel tree visible.
   Do not collapse the panel, switch tabs, resize the window, or interact with
   the canvas during the recorded interval.
6. Record the same 20 to 30 second window in each run with Chrome Performance
   and, when available for the build under test, React DevTools Profiler.

## What To Compare

Expected improvements from the performance fixes should show up as lower
frequency and shorter duration render samples for:

- `ProjectTree`: fewer full tree re-renders while leader messages stream.
- `SelectableMessageBubble`: fewer re-renders of completed bubbles when only
  the active streaming message changes.
- `SimpleMarkdown`: fewer repeated markdown parses for unchanged message text.
- Autosave churn: fewer saves or scheduled-save resets caused by transient
  session updates that should not persist canvas state.

Capture the commit SHA, browser version, viewport size, project path, profile
duration, and whether the tree filter was active. Store both trace files
together so the comparison can be replayed later.
