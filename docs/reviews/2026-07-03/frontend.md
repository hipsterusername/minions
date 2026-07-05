# Frontend Architecture Review

## A. How the Frontend Actually Works

Minions is a React 19 + Vite client centered on a persisted infinite canvas. `App.tsx` owns the project-level shell: it opens a WebSocket via `useSocket`, loads a project over the HTTP API, creates the primary reducers for `nodes` and `graph`, owns the viewport transform and project settings, and switches between activity, Kanban, and canvas views. Canvas state is persisted through `useAutosave`, which sends `{ transform, nodes, graph }` back to the project API after a debounce. Kanban is separate: it has its own reducer and persists to `localStorage` under `kanban-${projectId}`.

The canvas model is deliberately simple. `CanvasNode` is `{ id, type, position, size, data }`; `canvasReducer` updates an array of nodes with add/remove/move/resize/update/set/group-move actions. Edges live in a separate `graphReducer` over `GraphDocument`. The registry (`node-registry.ts`) maps a node type to its label, default size, renderer, context extraction hooks, and a few capability flags. A separate graph contract registry (`graph.ts`) defines node ports and edge protocols.

The render path is: `Canvas` maps every node to `CanvasNodeComponent`, which looks up the node renderer in the registry and threads a large shared prop surface into it. `CanvasNodeComponent` is memoized and uses `translate3d` for node position; `EdgeRenderer` is also memoized and renders SVG Bezier paths from graph edges. The canvas itself owns selection, panning, marquee selection, context menus, connection dragging, group containment, auto-layout triggers, session attachment, leader/minion/render spawning, and context lookup.

The WebSocket layer parses every server message through `wsEnvelopeSchema`, flattens the envelope into a `ServerMessage`, and fans it out to either firehose or topic subscribers. Session message reduction has a good shared path: `sessionStreamReducer` handles `sync_response`, `sdk_event`, `session_status`, and `session_error`; `useSessionStream` wraps it in a controlled hook that keeps the node data as the source of truth and frame-throttles transient streaming text. `LeaderNode` and `MinionNode` use that shared reducer, then layer node-specific subscriptions for worktree, approval, task plan, and minion/task-control events. `ClaudeSessionNode` still has an independent ad hoc stream reducer.

Render dashboards are driven by `render_update` events. `Canvas` auto-spawns a `render` node on the first update for a leader session, applies the first update immediately, and then the `RenderNode` subscribes to the leader topic, validates payloads with `renderMessageSchema`, and applies `applyRenderMessage` from `shared/render-dsl.ts`. Render nodes also expose context through the node registry by flattening the dashboard state to text.

The broad shape is functional and has several intentional guardrails: topic-scoped WebSocket subscriptions, a shared render DSL in `shared/`, a server file-size ratchet, a client shrink-only ratchet for the worst files, and tests around duplicate streaming behavior. The main architectural risk is that the system has grown by pushing orchestration into view components rather than by consolidating domain state and event reduction behind explicit modules.

## B. Strengths

- The WebSocket envelope is validated at the client boundary before dispatch. `useSocket` parses JSON, validates with `wsEnvelopeSchema`, and drops invalid messages before listener fan-out (`src/use-socket.ts:299`-`src/use-socket.ts:318`).
- Topic subscriptions are supported in the socket primitive, reducing unnecessary work for session-specific consumers (`src/use-socket.ts:190`-`src/use-socket.ts:219`, `src/use-socket.ts:356`-`src/use-socket.ts:369`).
- The shared session reducer has a clear reference-equality contract and handles duplicate/interleaved events (`src/session-stream.ts:19`-`src/session-stream.ts:23`, `src/session-stream.ts:184`-`src/session-stream.ts:307`).
- `useSessionStream` is a good migration target: controlled state preserves canvas persistence while centralizing stream reduction and frame-throttling transient streaming updates (`src/use-session-stream.ts:1`-`src/use-session-stream.ts:29`, `src/use-session-stream.ts:161`-`src/use-session-stream.ts:206`).
- The render DSL contract is meaningfully shared. `RenderNode` imports `RenderState`, `RenderComponent`, `applyRenderMessage`, and `renderMessageSchema` from `shared/render-dsl.ts`, and validates render payloads before applying them (`src/nodes/RenderNode.tsx:22`-`src/nodes/RenderNode.tsx:49`, `src/nodes/RenderNode.tsx:2311`-`src/nodes/RenderNode.tsx:2321`).
- Several performance-conscious choices already exist: `CanvasNodeComponent` and `EdgeRenderer` are memoized, node motion uses `translate3d`, and canvas scale is kept out of node props to avoid zoom-frame prop churn (`src/Canvas.tsx:827`-`src/Canvas.tsx:830`, `src/CanvasNode.tsx:140`, `src/CanvasNode.tsx:410`-`src/CanvasNode.tsx:418`, `src/EdgeRenderer.tsx:174`-`src/EdgeRenderer.tsx:183`).
- The architecture suite has begun ratcheting down client file-size debt for the most critical files (`tests/architecture/file-size.test.ts:86`-`tests/architecture/file-size.test.ts:142`, `tests/architecture/baselines.ts:65`-`tests/architecture/baselines.ts:78`).

## C. Findings

### 1. Critical: `ClaudeSessionNode` still uses a divergent streaming reducer with a known duplicate-message bug.

Evidence:
- The bug test states that the shared reducer dedups duplicate delivery, but `ClaudeSessionNode` does not use it and appends messages without content-based dedup (`src/streaming-duplicate-bug.test.tsx:8`-`src/streaming-duplicate-bug.test.tsx:20`).
- The test intentionally asserts the current bug: duplicate delivery produces at least two assistant bubbles (`src/streaming-duplicate-bug.test.tsx:192`-`src/streaming-duplicate-bug.test.tsx:235`).
- `ClaudeSessionNode` rebuilds sync messages with `normalizedToDisplayMessages(ev)` and pushes directly (`src/nodes/ClaudeSessionNode.tsx:123`-`src/nodes/ClaudeSessionNode.tsx:160`), then live events append `newMsgs` directly to `updated.messages` (`src/nodes/ClaudeSessionNode.tsx:871`-`src/nodes/ClaudeSessionNode.tsx:899`).
- By contrast, `LeaderNode` and `MinionNode` use `useSessionStream` (`src/nodes/LeaderNode.tsx:339`-`src/nodes/LeaderNode.tsx:344`, `src/nodes/MinionNode.tsx:450`-`src/nodes/MinionNode.tsx:455`).

Recommendation:
Migrate `ClaudeSessionNode` to `useSessionStream` and delete its ad hoc streaming/sync reducer. Keep any Claude-session-only UI concerns as a secondary subscription, matching the Leader/Minion pattern. Flip the duplicate bug test to assert one assistant bubble after the migration.

### 2. High: State ownership is split across reducers, local component state, refs, WebSocket effects, API autosave, and localStorage without a single authoritative frontend state model.

Evidence:
- Canvas node state is a reducer over only the node array (`src/canvas-state.ts:4`-`src/canvas-state.ts:36`), while graph edges are a separate reducer (`src/graph-runtime.ts:16`-`src/graph-runtime.ts:51`).
- Canvas adds many additional local sources of truth for selection, edge hover/selection, panning, marquee, menus, connection drag, group drag, and pending spawn registries (`src/Canvas.tsx:832`-`src/Canvas.tsx:1009`).
- Session state is embedded inside `node.data` and updated by WebSocket handlers via `UPDATE_NODE_DATA` (`src/Canvas.tsx:2527`-`src/Canvas.tsx:2557`, `src/nodes/LeaderNode.tsx:291`-`src/nodes/LeaderNode.tsx:344`).
- Kanban lives outside project persistence in `localStorage` (`src/use-kanban.ts:101`-`src/use-kanban.ts:120`, `src/use-kanban.ts:135`-`src/use-kanban.ts:150`), while project/canvas state is saved through the API (`src/use-autosave.ts:121`-`src/use-autosave.ts:164`).

Recommendation:
Define a frontend domain state boundary: either a `ProjectRuntimeProvider` or a small store/reducer module owning `{ nodesById, nodeOrder, graph, transform, sessions, kanbanRefs }`. Keep React local state for ephemeral UI only. Move WebSocket event reductions into explicit reducers/actions rather than direct component spreads. Move Kanban persistence into the project store or make the localStorage split explicit with conflict/recovery behavior.

### 3. High: `Canvas.tsx` is an orchestration god component, not just a canvas view.

Evidence:
- It is 4,626 lines, and the client file-size ratchet records that exact ceiling (`tests/architecture/baselines.ts:73`-`tests/architecture/baselines.ts:78`).
- It owns UI interaction state and menus (`src/Canvas.tsx:832`-`src/Canvas.tsx:931`), session attachment (`src/Canvas.tsx:1232`-`src/Canvas.tsx:1269`), active-node focus logic (`src/Canvas.tsx:1271`-`src/Canvas.tsx:1401` in search evidence), node data coupling for leader/render synchronization (`src/Canvas.tsx:2527`-`src/Canvas.tsx:2557`), WebSocket event handling for task plans/minion spawning/render spawning (`src/Canvas.tsx:3356`-`src/Canvas.tsx:3752`), context extraction (`src/Canvas.tsx:3754` onward), and all node rendering (`src/Canvas.tsx:4090`-`src/Canvas.tsx:4187`).

Recommendation:
Split by responsibility, not by JSX chunks:
- `useCanvasInteractionState`: selection, edge hover/selection, panning, marquee, context menus.
- `useConnectionDrag`: port target calculation, edge creation, snap state.
- `useGroupContainment`: context-group membership, drag/drop, auto-fit.
- `useCanvasSessionSpawner`: attach/reveal leader/minion/render, pending spawn refs.
- `useLeaderCanvasEvents`: the big leader-topic WebSocket reducer currently at `Canvas.tsx:3359`-`Canvas.tsx:3752`.
- `CanvasScene`: pure renderer that receives precomputed view-model props.

### 4. High: Whole-array node updates create avoidable render cascades under WebSocket floods.

Evidence:
- `canvasReducer` updates node data by mapping the entire node array and replacing the matching node (`src/canvas-state.ts:21`-`src/canvas-state.ts:24`).
- `Canvas` renders all nodes with `nodes.map(...)` on every nodes-array change (`src/Canvas.tsx:4150`-`src/Canvas.tsx:4187`).
- Every node receives broad props, including `connectedPorts`, `validTargets`, `snapTargetKey`, `getContextForNode={getStableContextGetter(node.id)}`, socket props, and many optional callbacks (`src/Canvas.tsx:4151`-`src/Canvas.tsx:4185`; `src/CanvasNode.tsx:12`-`src/CanvasNode.tsx:70`).
- `EdgeRenderer` rebuilds a node map whenever the nodes array changes and maps all edges (`src/EdgeRenderer.tsx:182`-`src/EdgeRenderer.tsx:232`).
- WebSocket events mutate node data frequently: task plan updates, minion progress, completion, render spawn, and render updates dispatch `UPDATE_NODE_DATA` or `ADD_NODE` (`src/Canvas.tsx:3424`-`src/Canvas.tsx:3428`, `src/Canvas.tsx:3499`-`src/Canvas.tsx:3503`, `src/nodes/RenderNode.tsx:2320`-`src/nodes/RenderNode.tsx:2321`).

Recommendation:
Normalize nodes into `{ byId, order }` and expose per-node selectors or per-node memoized subscriptions. At minimum, introduce a custom comparator for `CanvasNodeComponent` that ignores irrelevant global prop identity churn and splits static node renderer props from interaction props. For large boards, add viewport culling/virtualization for nodes and edges.

### 5. High: The node registry is real for rendering, but adding a node type still requires edits across multiple hard-coded branches.

Evidence:
- Registry capabilities exist (`src/node-registry.ts:3`-`src/node-registry.ts:47`) and `CanvasNodeComponent` uses `getNodeType(node.type)` to render (`src/CanvasNode.tsx:325`-`src/CanvasNode.tsx:329`).
- Defaults are still a central switch over concrete type strings (`src/node-defaults.ts:13`-`src/node-defaults.ts:104`).
- Context extraction still has legacy type branches for markdown/file-viewer/note (`src/context-extraction.ts:16`-`src/context-extraction.ts:24`, `src/context-extraction.ts:53`-`src/context-extraction.ts:71`).
- Minimap coloring is a switch over node types (`src/CanvasMiniMap.tsx:164`-`src/CanvasMiniMap.tsx:184`).
- Kanban only recognizes markdown/file-viewer context nodes (`src/KanbanBoard.tsx:2602`-`src/KanbanBoard.tsx:2617`).

Recommendation:
Extend `NodeTypeDefinition` with the missing extension hooks: `defaultData`, `miniMapStyle`, `deleteCascade`, `affinity/ownedChildren`, `dropBehavior`, `kanbanContextOption`, and lifecycle handlers. Move defaults and legacy context branches into node registrations. Keep truly cross-node orchestration in separate policies keyed by declared capabilities, not raw type strings.

### 6. Medium-High: Kanban and canvas duplicate session/leader state and mutate each other through props, creating sync races and persistence ambiguity.

Evidence:
- `ProjectView` derives `leaderStatuses` from canvas nodes for the Kanban board (`src/App.tsx:665`-`src/App.tsx:680` from search evidence).
- App effects auto-transition Kanban cards based on leader node state (`src/App.tsx:687`-`src/App.tsx:780`), auto-create cards for active leaders (`src/App.tsx:782`-`src/App.tsx:850`), update auto-synced card titles (`src/App.tsx:852`-`src/App.tsx:867`), and halt cards after sync failures/timeouts (`src/App.tsx:869`-`src/App.tsx:949`).
- The Kanban inspector sends `send_message` and directly appends a user message into the leader node via `onUpdateNodeData` (`src/KanbanBoard.tsx:2169`-`src/KanbanBoard.tsx:2203`).
- Kanban persists to localStorage, not the same project API save path as canvas nodes/graph/transform (`src/use-kanban.ts:101`-`src/use-kanban.ts:150` versus `src/use-autosave.ts:154`-`src/use-autosave.ts:164`).

Recommendation:
Make Kanban cards reference sessions/leaders but not duplicate live session state. Route Kanban chat sends through the same session reducer/action path used by the node, or derive the optimistic user message from a shared `sessionEvents` store. Persist Kanban with project state or explicitly version/sync local Kanban state against project state to avoid losing the operational board when the project moves between browsers/machines.

### 7. Medium-High: WebSocket contract discipline is uneven on the client side; receive envelopes are schema-checked, but outbound commands and many message casts are not.

Evidence:
- Inbound messages are envelope-validated in `useSocket` (`src/use-socket.ts:299`-`src/use-socket.ts:318`).
- The client-side `ServerMessage` union is hand-maintained in `src/use-socket.ts` and comments say several fields mirror server types and must be kept in sync (`src/use-socket.ts:11`-`src/use-socket.ts:38`, `src/use-socket.ts:52`-`src/use-socket.ts:79`).
- `Canvas` casts incoming messages to `{ type: string; [key: string]: unknown }` and then to ad hoc shapes for task-plan/minion/render handling (`src/Canvas.tsx:3365`-`src/Canvas.tsx:3387`, `src/Canvas.tsx:3436`-`src/Canvas.tsx:3449`, `src/Canvas.tsx:3681`-`src/Canvas.tsx:3709`).
- Outbound commands are raw object literals from many components (`src/KanbanBoard.tsx:2179`-`src/KanbanBoard.tsx:2184`, `src/KanbanBoard.tsx:2669`-`src/KanbanBoard.tsx:2678`, `src/nodes/RenderNode.tsx:2271`-`src/nodes/RenderNode.tsx:2276`).
- Cross-tree import rules prevent `src/` importing `server/`, which is good, but do not by themselves provide a typed command schema for the client (`tests/architecture/no-cross-tree-imports.test.ts:76`-`tests/architecture/no-cross-tree-imports.test.ts:107`).

Recommendation:
Move WebSocket command and server-message schemas/types into `shared/` and generate both client helpers and server validation from them. Add `sendCommand(command)` wrappers with schema validation or typed builders, so UI components do not mint raw protocol objects. Replace ad hoc casts in Canvas with parsed discriminated unions for event-specific reducers.

### 8. Medium: Undo history only covers node actions and can record high-frequency drag/session changes, while graph, transform, Kanban, and remote stream mutations sit outside the story.

Evidence:
- History actions are node-only actions, including every `MOVE_NODE`, `RESIZE_NODE`, `UPDATE_NODE_DATA`, and `MOVE_GROUP`; `SET_NODES` is excluded (`src/canvas-state.ts:38`-`src/canvas-state.ts:65`).
- Graph edge updates are in a separate reducer with no history integration (`src/graph-runtime.ts:16`-`src/graph-runtime.ts:51`).
- App uses plain `useReducer(canvasReducer, [])`, not `useCanvasHistory`, so the exported history hook is not wired at the project shell (`src/App.tsx:140`-`src/App.tsx:142`).
- `Canvas` accepts `undo` and `redo` props (`src/Canvas.tsx:807`-`src/Canvas.tsx:825`), but `App.tsx` does not pass them when rendering Canvas (`src/App.tsx:1051`-`src/App.tsx:1068`).

Recommendation:
Decide whether undo is a product feature or dead code. If it is a feature, move history above both node and graph reducers and record semantic user transactions: drag end, resize end, add/delete node with edge cascade, connect/disconnect edge, tidy layout. Exclude remote/session-stream mutations from undo. If not a feature, remove the unused hook and props to lower architectural noise.

### 9. Medium: File-size ratcheting covers only three client files, leaving other major frontend hotspots outside the architecture gate.

Evidence:
- `CLIENT_FILE_SIZE_ALLOWLIST` tracks only `src/Canvas.tsx`, `src/nodes/LeaderNode.tsx`, and `src/nodes/ClaudeSessionNode.tsx` (`tests/architecture/baselines.ts:65`-`tests/architecture/baselines.ts:78`).
- Current large files include `src/KanbanBoard.tsx` at 3,014 lines, `src/nodes/RenderNode.tsx` at 2,693, `src/nodes/MarkdownNode.tsx` at 1,835, and `src/App.tsx` at 1,168, but they are not shrink-only gated.
- The file-size test describes client tracking as only the CLAUDE.md callouts (`tests/architecture/file-size.test.ts:86`-`tests/architecture/file-size.test.ts:105`).

Recommendation:
Add a client file-size ratchet for all current files over a threshold, with shrink-only baselines. Suggested starting threshold: >1,000 lines in `src/`, excluding generated files. This should include `KanbanBoard.tsx`, `RenderNode.tsx`, `MarkdownNode.tsx`, and `App.tsx`. Keep the ratchet shrink-only, not a hard fail-to-400 rule yet.

### 10. Medium: `RenderNode` is both a DSL runtime and a full UI/component library in one 2,693-line file.

Evidence:
- It imports every DSL component type and owns rendering for metrics, progress, tables, lists, text, status, code, sparkline, KV, timeline, callout, separator, diff, checklist, tags, copyable, form, chart, section, tabs, image, and file preview (`src/nodes/RenderNode.tsx:22`-`src/nodes/RenderNode.tsx:58`).
- It also owns CSS injection, WebSocket subscription, payload validation, context-selection state, copy/export behavior, resize handling, and node registration (`src/nodes/RenderNode.tsx:2248`-`src/nodes/RenderNode.tsx:2345`, `src/nodes/RenderNode.tsx:2658`-`src/nodes/RenderNode.tsx:2693`).
- Some components have already been split into `src/nodes/render/` (`src/nodes/RenderNode.tsx:49`-`src/nodes/RenderNode.tsx:58`), but many primitives remain inline.

Recommendation:
Split `RenderNode` into:
- `RenderNodeRenderer.tsx`: node shell, subscription, resize, context selection.
- `render/RenderComponentView.tsx`: dispatch by DSL component type.
- `render/primitives/*.tsx`: metric/progress/table/list/text/status/code/etc.
- `render/useRenderUpdates.ts`: subscribe/validate/apply `render_update`.
Keep `render-flatten.ts` pure and separate as it already is.

### 11. Medium: Canvas performance has no virtualization/culling boundary for large infinite canvases.

Evidence:
- The scene renders every node unconditionally with `nodes.map(...)` (`src/Canvas.tsx:4150`-`src/Canvas.tsx:4187`).
- `EdgeRenderer` maps all edges and performs per-edge node lookup and port math (`src/EdgeRenderer.tsx:203`-`src/EdgeRenderer.tsx:232`).
- Group containment computes nested group/node checks (`src/Canvas.tsx:943`-`src/Canvas.tsx:955`), and auto-layout builds clusters by filtering edges/nodes inside loops (`src/auto-layout.ts:151`-`src/auto-layout.ts:186`).

Recommendation:

### 12. Low-Medium: Effect hygiene is mostly careful, but a few patterns should be tightened before more behavior is added.

Evidence:
- `LeaderNode` publishes canvas context in an effect with no dependency array, so it runs after every render and relies on signature dedup to avoid repeated sends (`src/nodes/LeaderNode.tsx:272`-`src/nodes/LeaderNode.tsx:287`).
- `Canvas` has a large topic subscription effect depending on a stringified topic key and many refs; it handles several unrelated message families in one closure (`src/Canvas.tsx:3346`-`src/Canvas.tsx:3752`).
- `ClaudeSessionNode` duplicates scheduling/cancel-frame logic already present in `useSessionStream` (`src/nodes/ClaudeSessionNode.tsx:34`-`src/nodes/ClaudeSessionNode.tsx:52`, `src/nodes/ClaudeSessionNode.tsx:706`-`src/nodes/ClaudeSessionNode.tsx:738`).
- The hot files contain many timers/listeners; most clean up correctly, but their spread across large components makes audit difficult (`src/Canvas.tsx:1901`-`src/Canvas.tsx:1903`, `src/Canvas.tsx:3272`-`src/Canvas.tsx:3273`, `src/KanbanBoard.tsx:107`-`src/KanbanBoard.tsx:108`, `src/nodes/MarkdownNode.tsx:500`-`src/nodes/MarkdownNode.tsx:501`).

Recommendation:
Prefer narrowly-scoped hooks with explicit dependencies over component-level effects. Add tests for subscription teardown where hooks own sockets. Move reusable frame scheduling into one utility and remove duplicate implementations.

## D. Top 5 Recommendations Ranked by Impact/Effort

1. **Migrate `ClaudeSessionNode` to `useSessionStream` and flip the duplicate bug test.**
   - Impact: Very high. Removes a known user-visible bug and deletes a divergent reducer.
   - Effort: Medium. The shared hook already exists and Leader/Minion show the target pattern.

2. **Extract `Canvas` WebSocket/session-spawn orchestration into hooks/reducers.**
   - Impact: Very high. Shrinks the riskiest file and isolates remote-event reduction from pointer/render concerns.
   - Effort: Medium-high. Start with `useLeaderCanvasEvents` around `Canvas.tsx:3359`-`Canvas.tsx:3752`, then `useCanvasSessionSpawner`.

3. **Normalize node state and add per-node render subscriptions or selectors.**
   - Impact: High. Reduces full-canvas render cascades from streaming/session updates and prepares for larger canvases.
   - Effort: High. Best done behind compatibility selectors so existing components can migrate incrementally.

4. **Promote node capabilities into the registry and remove type-switch sprawl.**
   - Impact: High. Makes adding node types predictable and reduces edits across Canvas, defaults, minimap, context, keyboard, and Kanban.
   - Effort: Medium. Start with `defaultData`, context extraction, and minimap style because they are easy wins.

5. **Unify or explicitly version Kanban persistence with project/canvas persistence.**
   - Impact: Medium-high. Prevents project state and board state drifting across browsers/reloads and lowers App reconciliation complexity.
   - Effort: Medium. Persist Kanban in the project API or add a clear project-local sync/version layer.

