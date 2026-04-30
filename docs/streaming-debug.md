# Streaming debug mode

How to use the in-app debug instrumentation, plus the root-cause notes
that led to it.

## TL;DR

Open the app, press **Ctrl/Cmd+Shift+D**. Every session node
(`leader`, `minion`, `claude-session`) gains a *Debug Inspector* panel
under its message feed showing:

- `streamingText` length and active `streamingBlockIndex` in real time,
- the last 25 SDK events received (newest-first, with type, block index,
  delta length, sub-agent flag),
- a flagged "duplicate content detected" panel listing any messages
  that share the same trimmed text — except the legitimate
  assistant→result collapse pair, which is suppressed.

A floating `● DEBUG` pill in the bottom-left confirms debug mode is on
and is itself a click-to-disable affordance. The flag persists in
`localStorage` (`minions:debug-mode`).

## What gets recorded

`recordWsMessageForDebug(sessionKey, msg, note?)` in
`src/debug-record-bridge.ts` is called from:

- `src/use-session-stream.ts` — the shared subscription hook used by
  `LeaderNode` and `MinionNode`, and
- `src/nodes/ClaudeSessionNode.tsx` — the ad-hoc subscription
  (`note: "claude"`) that does *not* use the shared hook.

Records are tiny digests, never the raw SDK message: SDK type,
stream-event sub-type, content-block index, delta length,
`uuid`, `parent_tool_use_id`, and an optional caller-supplied note.
Buffers are capped at **250 records per session key**.

When debug mode is off, `recordDebug` is a hard no-op — there's no
overhead in production.

## Why this exists — duplicate text in the chat

User report: assistant text occasionally renders twice — both during
the live preview (`streamingText` in `<StreamingBubble />`) and after
the message is committed to the feed.

### What's *not* the bug

The shared `sessionStreamReducer` in `src/session-stream.ts` is
correct. It:

- dedups complete-message appends by `m.id` (line 249-252),
- collapses the SDK's intentional assistant→result duplicate
  (`collapseAssistantResultDup`),
- resets `streamingText` on `message_stop`, on a complete `assistant`,
  and at the start of every new content block (block-boundary flush),
- ignores stream events from sub-agents
  (`parent_tool_use_id !== null`).

The reducer's tests in `src/session-stream.test.ts` pin every one of
those transitions. A new repro test in
`src/streaming-duplicate-bug.test.tsx` re-confirms the reducer is
robust to (a) duplicate complete events and (b) `sync_response`
re-delivery overlapping with live deltas.

### What *is* the bug

`src/nodes/ClaudeSessionNode.tsx` is the fallback renderer for
`claude-session` nodes and bypasses the shared reducer. It carries its
own `sdkMessageToSessionMessages` that mints a fresh
`crypto.randomUUID()` for every produced display message and appends
to `data.messages` with **no UUID-based deduplication**. When the same
SDK event is delivered twice (sync overlap, reconnect race, server
retry), two bubbles with different display IDs but identical content
land in the feed.

The same file's ad-hoc subscription also reads
`current = dataRef.current` at the top of every handler. `dataRef`
is refreshed via `dataRef.current = data` on each render, so a burst
of WS frames within a single render tick all see the same stale
snapshot. The shared `useSessionStream` hook avoids this by updating
its internal `stateRef` synchronously inside the subscription
callback (see `src/use-session-stream.ts:97-101`).

`src/streaming-duplicate-bug.test.tsx` captures the bug as a passing
test: re-delivering the same `assistant` event produces ≥ 2 assistant
bubbles, and `findDuplicateContent` flags them. When the underlying
issue is fixed (the obvious path: migrate ClaudeSessionNode to
`useSessionStream`, the same approach LeaderNode/MinionNode already
took), flip that test's assertion from `>= 2` to `=== 1` — the test
becomes the regression net.

### How to confirm in the wild

1. Enable debug mode (Ctrl/Cmd+Shift+D).
2. Drive a session that triggers the symptom.
3. The Debug Inspector flags any duplicate content the moment it
   lands. The recorder shows the SDK event sequence (uuids,
   block indexes, delta sizes) so you can match what the server sent
   against what the renderer committed.
4. Click **Copy JSON** to grab the full snapshot for a bug report —
   it includes `streamingText`, `streamingBlockIndex`, the rendered
   message list, and the recorder buffer.
