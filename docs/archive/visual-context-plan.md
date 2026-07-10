# Visual Context — Implementation Plan

**Status:** Archived historical plan. File references and sequencing describe
the repository state at the time of writing.
**Current testing agreement:** [`../testing-strategy.md`](../testing-strategy.md)

---

## What this is

Users want to drop a **rendered thing** onto the canvas — a pasted
screenshot, a design mockup, a live web page, a PDF page — mark it up
with pins, rectangles, arrows, and notes, and have those annotations
flow as **multimodal context** to a connected Leader. The Leader
receives the image *and* the annotations, so "fix the top-right button"
means something because the model can see the button.

It looks like a new node type. It is actually a **protocol migration**.
The existing `context` protocol carries `content: string` end-to-end:
canvas node → WebSocket → Leader system/user prompt → Claude SDK. There
is no native multimodal step anywhere in that chain. The UI is the last
mile, not the first.

---

## Non-goals

- **Not a Figma replacement.** No vector editing, no layered composition,
  no export of the marked-up artifact as a static asset.
- **Not a design-system tool.** No component extraction, no theme
  inspection, no design-token pickers.
- **Not a live collaboration surface.** Single-user canvas; the
  annotations belong to the local user's session.
- **Not a screen-recording feature.** Single-frame capture only in
  Phase 4 (`getDisplayMedia` for one frame, not a video stream).

---

## The seven assumptions this breaks

Repeated from the architectural evaluation so the plan is self-contained.
Each phase closes one or more of these; the matrix at the end tracks
which phase closes which.

| # | Assumption today | What breaks it |
|---|---|---|
| A1 | Context is a string concatenated into the user prompt (`LeaderNode.tsx:2988–3005`) | Images aren't strings. Server must compose structured SDK content blocks. |
| A2 | `extractContent: (data) => string \| null` is pure and sync (`types.ts:51`) | Image extractors need async resolution from an asset store. |
| A3 | Context is frozen once `sessionKey` is set (`graph.ts:94–97`) | Visual review is iterative; users will want mid-session annotations. |
| A4 | `node.data` is a small, diffable JSON blob (`server/db.ts`) | Inline base64 bloats rows and kills diffability. Asset store is forced. |
| A5 | ContextGroup value == character count (`ContextGroupNode.tsx:67`) | Images have no `.length`. Metric becomes meaningless without a token estimate. |
| A6 | Chat-UI `ContentBlock` union is text-only (`use-socket.ts:96–102`) | User turns containing images render as empty turns. |
| A7 | Minions receive text-only task descriptions (`task-tools.ts`, `MinionNode.tsx`) | Minions can't see the mockup the Leader is delegating from. |

---

## Prerequisites — coordination with the in-flight refactor

Two items **must** be negotiated before Phase 2 begins.

1. **Phase 1 of the refactor (SessionHost extraction) touches the exact
   code that composes context into the SDK query.** This plan's Phase 2
   rewrites that composition. Either the refactor's Phase 1 lands first,
   or this plan's Phase 2 owner accepts a rebase. **Decision owner:**
   whoever is driving the SessionHost extraction.

2. **Phase 2 of the refactor (typed bus replaces broadcast) controls how
   new WS messages get routed.** This plan's Phase 2 introduces two new
   WS commands (`upload_asset` ack, `attach_context_blocks`). They must
   be born on the bus, not on `broadcast(wss,…)` — the
   `no-direct-broadcast.test.ts` invariant will reject the shortcut once
   Phase 2 of the refactor lands. **Decision:** sequence this plan's
   Phase 2 *after* the refactor's Phase 2, or build on the interim bus
   scaffolding if partial.

If both items slip, this plan's Phase 1 is still safely shippable — it
touches shared types and a mechanical node-wrap, nothing on the server
hot path.

---

## Phase 1 — Protocol foundation

**Goal:** flip `ContextItem.content: string` → `ContextItem.blocks:
ContextBlock[]` across the codebase, with every existing node wrapping
its string in a single `{type:"text", text}` block. Zero behavior change
visible to the user. Closes **A2** and sets up A1.

**Files created**

- `shared/context-types.ts` — neutral module; no deps on `src/` or
  `server/`. Owns `ContextBlock`, `AssetRef`, `VisualAnnotation`,
  `ContextItemV2`. (Naming TBD; see decision register D1.)
- `shared/context-types.test.ts` — shape tests for the discriminated
  union.

**Files changed**

- `src/types.ts` — `ContextItem` becomes an alias of `ContextItemV2`.
  `extractContent` signature becomes
  `(data) => ContextBlock[] | Promise<ContextBlock[]> | null`.
- `src/graph.ts` — `ContextPayload.content: string` →
  `ContextPayload.blocks: ContextBlock[]`.
- `src/Canvas.tsx` (2500–2565) — `getContextForNode` returns blocks.
- `src/nodes/FileViewerNode.tsx`, `MarkdownNode.tsx`, `FolderNode.tsx`,
  `ContextGroupNode.tsx` — each `extractContent` returns
  `[{type:"text", text: <old string>}]`.
- `src/nodes/LeaderNode.tsx` (2988–3005) — flatten blocks back into the
  current XML-in-prompt string. **Temporary; removed in Phase 2.** This
  is the mechanical adapter that lets Phase 1 ship with zero behavior
  change.
- `src/ContextGroupNode.tsx:67` — badge reads
  `blocks.reduce((n, b) => n + (b.type==="text" ? b.text.length : 0), 0)`
  so the char count still works for today's text-only world.

### Pre-flight

| Suite | Must pass on `main` |
|---|---|
| canvas reducer | `src/canvas-state.test.ts` |
| graph contracts | `src/graph.test.ts` |
| graph runtime | `src/graph-runtime.test.ts` |
| sdk → display | `src/sdk-messages.test.ts` |
| streaming | `src/streaming.test.ts` |
| all architecture tests | `tests/architecture/*.test.ts` |

### In-flight

- `shared/context-types.test.ts` — shape of ContextBlock union.
- `src/Canvas.test.tsx` (new) — `getContextForNode` returns blocks; an
  edge carrying a text-only payload round-trips unchanged.
- `src/nodes/FileViewerNode.test.tsx` (new if absent) — extractor
  returns `[{type:"text", ...}]`.
- `src/nodes/MarkdownNode.test.tsx` (existing, updated) — extractor
  returns `[{type:"text", ...}]`.
- `tests/architecture/no-cross-tree-imports.test.ts` — extend to forbid
  `from "../src/"` in `shared/` and `from "../server/"` in `shared/`.

### Post-flight

- Every node with `providesContext: true` emits blocks.
- `ContextPayload` carries blocks on every edge.
- `tests/architecture/file-size.test.ts` green — no server file grew.
- `LeaderNode.tsx` still under its current line count (the adapter is
  ~10 lines).

### Exit criteria

- `pnpm verify` green.
- `grep -rn "content: string" src/ server/ | grep -i context` returns
  zero matches in the context pipeline. (Incidental matches in unrelated
  code are fine.)
- One commit migrating the whole codebase. Mechanical, large diff, high
  confidence. **Do not** split across commits — half-migrated state is
  worse than either end.

### Risk

- **Missed extractor.** A node that declared `providesContext: true`
  without being updated returns a `string`, not blocks. Mitigation:
  TypeScript will catch this at compile time because the return type
  changed.
- **Stale tests.** Any test that asserts on `item.content` string shape
  must be updated. Count this effort upfront; `grep -rn "\\.content"
  src/` is the starting set.

---

## Phase 2 — Multimodal pipeline

**Goal:** images flow end-to-end from an asset store, through the WS
layer, to the Claude SDK as native image content blocks, and render in
the chat UI. At the end of Phase 2 the pipeline works with a **stubbed**
image block — there's no UI to author one yet. That's deliberate; it
lets us test the plumbing in isolation.

Closes **A1**, **A4**, **A6**. Surfaces **A5**.

**Prereq gates:** see the "Prerequisites" section above — both refactor
items should be resolved before this phase begins.

**Files created**

- `server/context-resolver.ts` (≤250 lines) — resolves
  `AssetRef`s to base64 and composes SDK user-turn `content[]` from
  `ContextBlock[]`.
- `server/routes/assets.ts` (≤200 lines) —
  `POST /api/projects/:id/assets` (multipart upload, returns AssetRef)
  and `GET /api/projects/:id/assets/:hash` (authenticated download).
- `server/asset-store.ts` (≤150 lines) — content-hash filesystem
  layout under `~/.minions/projects/<projectId>/assets/<sha256>.<ext>`.
  See decision register D2 for why *outside* the project tree.
- `server/context-resolver.test.ts`, `server/asset-store.test.ts`,
  `server/routes/assets.test.ts`.

**Files changed**

- `src/use-socket.ts` (96–102) — `ContentBlock` union gains `image`.
- `src/sdk-messages.ts` — mapping for image blocks in user turns.
- `src/nodes/ClaudeSessionNode.tsx`, `src/nodes/LeaderNode.tsx` — chat
  feed renders image blocks (thumbnail, click for full size).
- `src/nodes/LeaderNode.tsx` (2988–3005) — **remove the
  string-XML-in-prompt path.** Context blocks ride as a separate
  `contextBlocks` field on `create_session`; the prompt stays the user's
  literal prompt. This is the "replace, don't deprecate" move from the
  project's CLAUDE.md.
- `server/commands/create-session.ts` — accept and validate
  `contextBlocks`.
- `server/session-host*.ts` — call `context-resolver` before invoking
  the SDK; pass composed `content[]` as the first user turn.
- `src/prompts/leader-system.ts` — document how visual context arrives
  (this prompt is currently silent on context shape entirely; pre-existing
  gap, fixed here).
- `.gitignore` — no change needed; assets live outside the project tree
  (D2). Document the decision in the file header of `server/asset-store.ts`.

### Pre-flight

- Phase 1 exit criteria satisfied.
- `tests/architecture/no-direct-broadcast.test.ts` enforces zero
  `broadcast(wss,…)` calls outside the bus — new WS messages must
  already use it.

### In-flight

- `server/asset-store.test.ts` — content-hash dedupe, media-type
  inference, size cap enforcement (1568 px longest edge on write).
- `server/routes/assets.test.ts` — auth required, idempotent upload,
  404 on unknown hash, no path traversal.
- `server/context-resolver.test.ts` — text-only blocks round-trip as
  SDK text; image blocks resolve to base64 and are wrapped in the
  SDK's image-content-block shape; missing AssetRefs fail loudly.
- `tests/contracts/create-session.test.ts` — the WS `create_session`
  command accepts `contextBlocks` and rejects malformed shapes.
- `src/sdk-messages.test.ts` — SDK user turn with an image content
  block renders as `DisplayMessage` with an image attachment.
- `src/nodes/LeaderNode.test.tsx` — chat feed renders a user-turn
  image (mocked asset URL).

### Post-flight

- Integration test: a stubbed `ContextBlock[]` containing one image
  block arrives at a Leader session, the server composes a proper SDK
  request with an `image` content block, and the (mocked) SDK receives
  it. End-to-end, no UI.
- `tests/architecture/file-size.test.ts` — all new files ≤400 lines.
- `tests/architecture/no-cross-tree-imports.test.ts` — allowlist
  didn't grow. `shared/context-types.ts` is reachable from both sides;
  that's the whole point.

### Exit criteria

- `pnpm verify` green.
- The XML-in-prompt adapter from Phase 1 is deleted.
- `server/index.ts` did not grow (still on its pre-existing shrinkage
  trajectory).
- A manual smoke test harness (a unit test, not a UI) can POST a
  stubbed context block payload and watch the Leader SDK request arrive
  with a correct image block.

### Risks

- **SDK shape drift.** The Anthropic SDK's image block format is well
  documented but not frozen. Keep the composition function small and
  version-pinned; test against a recent fixture.
- **Asset URL auth.** `GET /assets/:hash` needs the same auth middleware
  every other project route uses. Don't invent a new scheme.
- **WS message size.** Even `AssetRef`-only messages are small, but the
  `create_session` payload with many blocks could approach the frame
  limit. Enforce a hard cap (e.g. 64 blocks per session).

---

## Phase 3 — ImageNode + annotation layer

**Goal:** the user-facing feature. Paste or drag an image onto the
canvas → it becomes an `ImageNode` → mark up with pins and rectangles →
connect to a Leader → the Leader receives the image plus the pin/rect
notes as a single `image+annotations` context block.

Closes **A5** (by introducing a token-aware ContextGroup badge).
Surfaces **A3** and **A7** as UX papercuts users will complain about;
neither is solved here.

**Files created**

- `src/components/AnnotationLayer.tsx` (≤250 lines) — SVG overlay that
  owns normalized-coordinate markup. Reused by `WebPreviewNode` in
  Phase 4; designed for reuse now.
- `src/components/MarkupToolbar.tsx` (≤150 lines) — pin / rect tool
  picker, note editor, color.
- `src/nodes/ImageNode.tsx` (≤300 lines — hard target) — composed
  from the two components above plus the paste/drop wiring and the
  context extractor.
- `src/nodes/ImageNode.test.tsx` — render, pin add/remove, coord
  normalization, extractor output shape.
- `src/components/AnnotationLayer.test.tsx`.
- `src/components/MarkupToolbar.test.tsx`.

**Files changed**

- `src/Canvas.tsx` — global paste/drop handler: if clipboard has an
  image and no text field is focused, POST to the asset route and
  create an `ImageNode` at the pointer.
- `src/App.tsx` — register `ImageNode` (side-effect import, as
  `registerNodeType` uses today).
- `src/node-registry.ts` — `extractContent` on `ImageNode` returns
  `[{type:"image+annotations", asset, annotations}]`.
- `src/nodes/ContextGroupNode.tsx` — badge becomes mixed:
  `"3 blocks · 2 img · 14k chars"`. Token-estimate column added in a
  later phase; this is the honest-mixed display for now.
- `src/prompts/leader-system.ts` — short update pointing the Leader at
  how to read the `image+annotations` block (coordinates are 0–1
  normalized, pins have order, etc.).

### Pre-flight

- Phase 2 exit criteria satisfied.
- The stubbed-block smoke test from Phase 2 still green — confirms the
  pipeline still works before we add the UI.

### In-flight

- `src/nodes/ImageNode.test.tsx` — paste a small test PNG (fixture),
  node is created, extractor returns an `image+annotations` block with
  the right AssetRef.
- `src/components/AnnotationLayer.test.tsx` — pin add/move/delete;
  coordinate normalization survives a container resize; rect drag.
- `src/Canvas.test.tsx` — paste handler ignores text-field focus;
  duplicate paste (same hash) reuses the existing asset.
- `tests/contracts/image-node.test.ts` — `ImageNode` has a
  `context-out` port with protocol `"context"`.

### Post-flight

- End-to-end test with a real (mocked SDK) Leader session: paste image
  → add 2 pins + 1 rect → connect → start session → assert the SDK
  request carries the image block and the annotation text block in the
  right order.
- `tests/architecture/file-size.test.ts` — `ImageNode.tsx` ≤300 lines,
  `AnnotationLayer.tsx` ≤250, `MarkupToolbar.tsx` ≤150.

### Exit criteria

- `pnpm verify` green.
- Feature demo: drag a screenshot onto a fresh canvas, pin two
  elements, connect to a Leader, start a session, the Leader references
  the pinned elements by their note content in its first response.
- No new server broadcast call sites; new messages ride the bus.

### Risks

- **Paste collision with text fields.** Global paste handlers are
  fragile. Test matrix: empty canvas, text node focused, Leader prompt
  focused, markdown node edit mode.
- **Coordinate drift on zoom.** Normalized coords (0–1) must be applied
  at render time. Tested explicitly by a resize-and-re-click test.
- **Large images.** Downscale happens server-side on upload (1568px
  longest edge). The client sends originals; the asset store responds
  with the downscaled AssetRef. Tested.
- **Annotation serialization cost.** A user with 40 pins on one image
  emits a long text block. Acceptable; document the cap (e.g. 50
  annotations per node, soft-warn above 20).

---

## Phase 4 — Extension & bidirectional

**Goal:** more visual sources, better markup, agent-authored
annotations, and the minion-vision fix (A7). Each item in this phase is
**independently shippable**; they are not a single PR. Pick one per
sprint based on user pull.

Closes **A3** and **A7** if the relevant subitems are taken.

### 4a · Richer markup

- Arrow, freehand, text-callout, highlight tools in
  `AnnotationLayer.tsx`.
- Undo/redo stack per node (scoped to the annotation layer; does not
  interact with canvas undo).
- Color picker with a small fixed palette keyed to the theme.

### 4b · WebPreviewNode (snapshot)

- New dep: `playwright` (server-only).
- `POST /api/projects/:id/web-snapshot?url=…` → downloads the page to a
  headless browser, screenshots at a configurable viewport, writes to
  the asset store, returns an AssetRef.
- `src/nodes/WebPreviewNode.tsx` — same annotation layer as `ImageNode`,
  different source. The recapture button preserves annotations if the
  new image has the same dimensions.

### 4c · Live web preview

- `src/nodes/WebPreviewNode.tsx` — live mode uses `<iframe>` with an
  overlay annotation layer. Restricted to **localhost** URLs because
  cross-origin CSP blocks overlay-to-iframe interaction.
- "Freeze" button converts a live node to a snapshot node using the
  same Playwright capture endpoint.

### 4d · ScreenCaptureNode

- `getDisplayMedia()` → single frame → asset store. Same annotation
  layer. Useful for "my actual app right now, not in localhost."

### 4e · PdfPageNode

- `pdf.js` renders a page to a canvas → exported as PNG → asset store.
- One node per page is simpler than a paged node and composes better
  with other annotations.

### 4f · Agent-authored annotations (A3)

- New MCP tool on Leader sessions:
  `annotate_image({ assetId, kind, geometry, note })` — lets the agent
  pin findings back onto a visual the user pinned first.
- Relaxes A3: context-in stays locked for the initial blocks, but
  agent-authored annotations are a separate bidirectional channel that
  writes to the node's data. The visual becomes a shared scratchpad.

### 4g · Minion vision (A7)

Three candidate fixes; pick one based on token-cost tolerance:

1. **Re-emit.** When a Leader delegates via `assign_task`, it may
   include a list of `contextNodeIds`; the server re-resolves those
   nodes' context blocks and sends them as the minion's first user
   turn. **Most principled, most code.** Reuses everything from Phase 2.
2. **Passthrough.** The `task-assignment` message gains a
   `contextBlocks` field alongside the description; the Leader copies
   what it wants the minion to see. **Middle ground.**
3. **Leader-only vision.** Explicitly document that minions don't see
   images; the Leader must describe the image in the task text. **No
   code, worst UX.**

Recommendation: **option 1.** It composes cleanly with the Phase 2
pipeline and does not fork the task-assignment protocol.

### 4h · Render DSL image component

For symmetry. Agents can render images back to the dashboard as
evidence. One new `image` component in `shared/render-dsl.ts` and
`server/render-tools.ts`. Small, reuses the asset store. Worth doing
whenever render-DSL changes are already open.

---

## Assumption-closure matrix

| Assumption | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|:---:|:---:|:---:|:---:|
| A1 — string-concat prompt | staged | **closed** | — | — |
| A2 — pure sync extractor | **closed** | — | — | — |
| A3 — context frozen at start | — | — | surfaced | **closed (4f)** |
| A4 — node.data small + diffable | — | **closed** | — | — |
| A5 — char count == value | — | surfaced | **closed** | refined |
| A6 — chat text-only | — | **closed** | — | — |
| A7 — minion text-only tasks | — | — | surfaced | **closed (4g option 1)** |

---

## Decision register

Open questions that must be answered **before** the phase that depends
on them. Each has a default, marked.

| ID | Question | Default | Owner | Gate phase |
|---|---|---|---|---|
| D1 | Module name — `shared/context-types.ts` vs `src/shared/…` vs a top-level `types/` dir. | `shared/context-types.ts` at repo root, neither `src/` nor `server/` imports it with `../src/` or `../server/`. | lead | Phase 1 |
| D2 | Asset store location — inside the project tree (`.minions/assets/`, needs gitignore) vs outside (`~/.minions/projects/<id>/assets/`). | **Outside.** Keeps `git status` clean, keeps worktree approval diffs sane, portable across clones. | lead | Phase 2 |
| D3 | Render mode — raw image + structured annotation text vs server-flattened marked-up PNG. | **Raw + list.** Optional flattened fallback cached by `(assetHash, annotationsHash)`. | lead | Phase 2 |
| D4 | Image downscale policy — 1568 px longest edge, auto on upload, keep original. | **Adopt.** Matches Claude API caps; keep the original for re-processing. | lead | Phase 2 |
| D5 | Paste policy — grab Cmd+V globally when no text field focused and clipboard contains image. | **Adopt.** Fall back to existing text-paste otherwise. | lead | Phase 3 |
| D6 | Minion vision fix (A7). | **Option 1 (re-emit).** | lead | Phase 4g |
| D7 | Token-budget accounting. Pre-existing gap surfaced by A5. Whose problem is it? | **Out of scope for this plan.** File a separate issue; ContextGroup gets the mixed badge as an interim honest display. | lead | — |

---

## What the suite will catch

The invariants from `tests/architecture/` are doing real work here.
Each phase has a specific test it could trip:

- `file-size.test.ts` — Phase 3's `ImageNode.tsx` has a hard 300-line
  target; composition over monolithic is the safety rail.
- `no-cross-tree-imports.test.ts` — Phase 1 introduces `shared/`. Update
  the test to enforce that `shared/` cannot import from either tree.
- `no-direct-broadcast.test.ts` — Phase 2's new WS messages must ride
  the bus. If the refactor's Phase 2 hasn't landed yet, this plan's
  Phase 2 is blocked.
- `command-table.test.ts` (arriving in refactor Phase 5.2) — the new
  `upload_asset` and `attach_context_blocks` commands must appear in
  the table with handlers. This plan's Phase 2 lands before refactor
  Phase 5.2, so this check is *post-hoc*; don't forget the entries.

---

## Open coordination items

1. Who owns refactor Phase 1 (SessionHost extraction)? This plan's
   Phase 2 needs to know whether to wait or rebase.
2. Who owns refactor Phase 2 (typed bus)? Same question.
3. Is there an existing asset-handling pattern elsewhere in the server
   (drag-drop file uploads at `server/routes/files.ts:136` touches
   base64)? Worth a read before Phase 2 to avoid reinventing.
4. Does the approval/worktree flow need any change to *ignore* the
   asset store when computing diffs? Answer depends on D2 — if assets
   live outside the project tree, no change needed. If they ever move
   inside, revisit.

---

## Not in this plan

- Bidirectional image generation (agent draws an image for the user).
  Out of scope; the render-DSL `image` component in 4h is for
  displaying user-provided or SDK-returned images, not for model image
  generation.
- Video context. Claude doesn't accept video; single frames only.
- Any integration with external tools (Figma API, Linear attachments,
  Slack paste). Scoped out; ImageNode covers the universal case of
  "paste the screenshot."
- Migrating the existing `loadedContent` fields on FileViewerNode /
  FolderNode away from `string` storage. Their extractor already wraps
  for the new protocol; the underlying field can stay a string forever.
