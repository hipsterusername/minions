# Minions Contract & Boundary Review

## Contract Landscape


The outbound WebSocket surface is less complete. `server/bus.ts` reliably wraps every server-to-client message in a `topic` + `type` envelope, and architecture tests prevent obvious bypasses. But `shared/ws-envelope.ts` validates only the envelope header and intentionally leaves payload fields loose. The client validates this envelope in `src/use-socket.ts`, then casts the result to a locally defined `ServerMessage` union. Individual consumers sometimes add domain validation, notably `RenderNode` for `render_update`, but most outbound event families are still convention-driven.

`NormalizedEvent` is the shared server/client event abstraction for harness output, but it is TypeScript-only: there is no runtime schema for SDK events crossing persistence or WS boundaries. It has improved decoupling for normal text/tool/usage streams, yet still carries Claude-specific concepts in comments, meta fields, sub-agent event names, and `parent_tool_use_id` semantics mapped into `parentId`.

The architecture test suite enforces important boundaries: no `src`/`server` imports, no direct `broadcast` outside the bus, no raw `ws.send(JSON.stringify(...))` outside the bus, Claude SDK import isolation, task lifecycle authority, token-efficient tool results, and shrink-only file-size baselines. Missing invariants are mostly around contract completeness: zod-at-boundary for outbound payloads, shared-vs-client type drift, shared import direction, protocol versioning, and ensuring every bus event type has a schema.

## Strengths

- Inbound WS validation is centralized and exhaustive over `WsCommandType`; `COMMAND_SCHEMAS` is a `Record<WsCommandType, z.ZodType>` and `validateWsCommand` rejects malformed JSON-shaped commands before dispatch.
- The bus is a strong routing choke point. `createBus` wraps `session`, `project`, and `global` topics, while architecture tests ban raw broadcast and direct JSON sends outside `server/bus.ts`.
- Render DSL is the best-developed shared contract: schemas, types, reducer, server tool validation, default elision, and producer/consumer round-trip tests all exist.
- Claude SDK import isolation is now enforced with an empty allowlist outside `server/harness/claude`.

## Findings

### 1. High - Outbound WS payloads are not schema-validated, only envelope headers are

Evidence:
- `shared/ws-envelope.ts:66-69` defines `wsEnvelopeSchema` as a loose object requiring only `topic` and `type`.
- `src/use-socket.ts:301-313` parses JSON, validates `wsEnvelopeSchema`, then casts `envelope as unknown as ServerMessage`.
- `tests/contracts/ws-envelope.test.ts:63-68` and `tests/contracts/ws-envelope-roundtrip.test.ts:64-80` assert only that envelopes parse, not that payloads match `ServerMessage`.

Impact: a new server event can pass client validation with missing or mistyped payload fields, then fail later in a component or silently corrupt UI state.

Recommendation: introduce a shared `serverMessageSchema`/`WsServerEvent` discriminated union for all outbound event types. Keep `wsEnvelopeSchema` as the transport wrapper, but validate `type`-specific payloads either in the bus or in `useSocket` before listener delivery.

### 2. High - No protocol version or capability handshake exists for deploy skew

Evidence:
- `shared/ws-envelope.ts:66-69` has no `version`, `protocol`, or capability field.
- `server/ws-connection.ts:40-43` sends only `{ type: "session_list", sessions }` on connect.
- `src/use-socket.ts:301-318` accepts any envelope with a valid `topic` and string `type`; unknown/new types are delivered to listeners without negotiated compatibility.

Impact: an old client connected to a newly deployed server can receive event types or payload shapes it does not understand. The current behavior is best-effort ignore/cast, not explicit compatibility management.

Recommendation: add a minimal protocol version handshake on connect, e.g. server advertises `{ type: "protocol_hello", protocolVersion, capabilities }`; client sends supported version/capabilities or includes them in the WS URL. Gate incompatible changes explicitly.

### 3. High - Client `ServerMessage` duplicates shared/server contracts and is drift-prone

Evidence:
- `src/use-socket.ts:11-38` defines a large local `ServerMessage` union for server events.
- Comments acknowledge manual mirroring: `src/use-socket.ts:52-56` says `HarnessCapabilities` mirrors `server/harness/types.ts`; `src/use-socket.ts:67-70` says `HarnessListEntry` mirrors `server/commands/list-harnesses.ts`.
- `server/session-host-run.ts:298-305`, `server/render-tools.ts:140-150`, and `server/commands/sync-session.ts:49-93` produce outbound shapes independently of that client union.

Impact: type safety stops at the tree boundary. The compiler cannot prove server producers and client consumers agree, and the architecture tests do not check this drift.

Recommendation: move outbound event types and schemas to `shared/ws-events.ts` or equivalent. Have server producers type against shared event constructors and have `src/use-socket.ts` infer its message union from shared zod schemas.

### 4. Medium - Bus `emit()` is an unvalidated escape hatch

Evidence:
- `server/bus.ts:59-62` exposes `emit(envelope: WsEnvelope)` as a public escape hatch.
- `server/bus.ts:142-145` forwards prebuilt envelopes directly through `fanOut`.
- `tests/contracts/ws-envelope.test.ts:96-108` and `tests/contracts/ws-envelope-roundtrip.test.ts:128-138` explicitly exercise this escape hatch with hand-built envelopes.

Impact: `emitToSession` and `emitGlobal` enforce topic construction, but `emit()` lets any producer bypass topic derivation and any future payload validation unless separately guarded.

Recommendation: restrict `emit()` to in-process replay/push-notifier use cases or rename it to `emitEnvelopeUnsafe` with an architecture test limiting call sites. If outbound schemas are added, validate `emit()` as well.

### 5. Medium - NormalizedEvent is not a runtime contract

Evidence:
- `shared/normalized-event.ts:23-104` exports only a TypeScript union, not a zod schema.
- `tests/contracts/normalized-event.test.ts:17-24` round-trips typed literals through JSON, then casts parsed output back to `NormalizedEvent`.
- `server/session-host-run.ts:298-305` places `NormalizedEvent` directly into `sdk_event` payloads sent over the bus.

Impact: malformed persisted events, harness translator bugs, or test casts can produce invalid `NormalizedEvent` values that are still delivered as `sdk_event` because there is no runtime parser at the boundary.

Recommendation: add `normalizedEventSchema` as a discriminated zod union and use it in harness translator tests, persistence hydration, and the `sdk_event` outbound schema.

### 6. Medium - NormalizedEvent still leaks Claude-specific sub-agent and metadata concepts

Evidence:
- `shared/normalized-event.ts:13-16` documents `parentId` with "Anthropic parent_tool_use_id semantics".
- `shared/normalized-event.ts:77-87` labels `agent_spawned` and `agent_task_update` as "Claude Agent-tool sub-agents".
- `server/harness/claude/index.ts:256-276` maps Claude `system/task_started` and `task_notification` directly to those event kinds.
- `server/harness/claude/index.ts:277-292` attaches raw Claude init metadata such as `mcp_servers`, `slash_commands`, and `claude_code_version`.

Impact: the abstraction decouples ordinary message flow, but the shared vocabulary still exposes Claude-specific lifecycle and metadata. Non-Claude harnesses either ignore those variants or must map their concepts into Claude-shaped names.

Recommendation: split generic harness events from provider extensions. For example, rename sub-agent variants to provider-neutral task lifecycle events and place provider-specific init metadata behind `{ provider, data }` or a typed extension bag.

### 7. Medium - Render container schemas accept arbitrary nested child shapes

Evidence:
- `shared/render-containers.ts:22-24` defines `childComponentSchemaLoose = z.unknown()`.
- `shared/render-containers.ts:28-35` and `40-52` validate `section.components` and `tabs[].components` as arrays of unknowns.
- `shared/render-dsl.ts:481-485` casts parsed set components back to `RenderComponent[]`.

Mitigating evidence:
- `server/render-tools.ts:59-80` recursively calls `parseRenderComponent` for server-side tool input, so agent-originated render tool payloads are validated before state mutation.

Impact: the exported shared schema is weaker than the exported `RenderComponent` type. Any code path that uses `renderComponentSchema` directly, outside `server/render-tools.ts`'s recursive wrapper, can accept invalid nested children.

Recommendation: make recursive validation a shared helper, e.g. `parseRenderComponentDeep` / `renderComponentDeepSchema`, and require contract tests to exercise invalid nested children through the same parser that producers use.

### 8. Medium - Render patch accepts arbitrary fields and can broadcast unvalidated invalid state deltas

Evidence:
- `shared/render-dsl.ts:438-445` defines render patch updates as `{ id: string }.passthrough()`.
- `server/render-tools.ts:162-170` duplicates that passthrough schema for tool input.
- `server/render-tools.ts:186-191` merges arbitrary patch fields into `renderState.components[idx]` and casts to `RenderComponent`.
- `server/render-tools.ts:195-200` broadcasts the raw `args.updates` without revalidating the resulting component or the patch message.

Impact: a patch can set fields to invalid types or add junk fields. The existing `type` is preserved, but type-specific invariants are not rechecked after merge.

Recommendation: after applying each patch, validate the merged component with deep render parsing before mutating state or broadcasting. Consider type-specific partial patch schemas if patch expressiveness needs to remain broad.

### 9. Medium - Cost of adding a render component is high and easy to miss

Evidence:
- A new component requires adding a schema/type in `shared/render-dsl.ts` or a family module, adding the literal to `RENDER_COMPONENT_TYPES` at `shared/render-dsl.ts:301-324`, adding it to `renderComponentSchema` at `shared/render-dsl.ts:349-372`, adding defaults in `shared/render-defaults.ts:49-72`, adding rendering UI in `src/nodes/render/*` or `RenderNode`, adding flattening in `src/render-flatten.ts`, and updating contract/unit tests such as `tests/contracts/render-dsl-roundtrip.test.ts:188-220`.

Impact: the DSL is extensible, but the extensibility mechanism is manual and scattered. Missing one location can create a component that validates but does not render, renders but does not elide defaults, or is omitted from documentation/prompt guidance.

Recommendation: add an architecture test that enumerates `RENDER_COMPONENT_TYPES` and asserts parity with `renderComponentSchema` options, `COMPONENT_DEFAULTS`, renderer dispatch, flattening dispatch, and the contract representative list.

### 10. Medium - `src/Canvas.tsx` handles major WS events with repeated `unknown as` casts

Evidence:
- `src/Canvas.tsx:3372-3387` casts `task_plan_update` payload manually.
- `src/Canvas.tsx:3436-3449`, `3508-3521`, `3554-3575`, and `3607-3618` repeat the same pattern for minion and agent events.
- `src/Canvas.tsx:3681-3709` casts a full `render_update` envelope directly to `RenderMessage`, unlike `RenderNode` which validates with `renderMessageSchema.safeParse` at `src/nodes/RenderNode.tsx:2311-2318`.

Impact: the graph-as-bus routing layer is one of the most important consumers of outbound contracts, but it relies on local casts and has inconsistent validation compared with dedicated nodes.

Recommendation: replace Canvas event casts with shared payload schemas or small typed parsing helpers. At minimum, use `renderMessageSchema.safeParse` for the first render update before calling `applyRenderMessage`.

### 11. Low - Prompt contracts are split asymmetrically across `shared/prompts` and `src/prompts`

Evidence:
- `shared/prompts/minion-system.ts:1-9` is the canonical minion prompt shared by server and client.
- `src/prompts/minion-system.ts:1-6` re-exports that shared prompt.
- `src/prompts/leader-system.ts:1-23` keeps the leader prompt client-side with injected tool names; `src/prompts/build-leader-prompt.ts:13-46` assembles it with skills.

Impact: the minion prompt has a clean shared contract, but the leader prompt remains in `src`, which is surprising because server agents also need system prompts. This increases the chance of future cross-tree pressure or duplicated prompt assembly.

Recommendation: move leader prompt construction primitives that are shared by server/runtime and client/default UI into `shared/prompts/leader-system.ts`, keeping UI-only prompt editor code in `src/prompts`.

### 12. Low - Architecture tests miss several contract invariants

Evidence:
- `tests/architecture/no-cross-tree-imports.test.ts:76-107` enforces only `src` <-> `server` imports, not `shared` import direction.
- `tests/architecture/file-size.test.ts:113-142` tracks only allowlisted large client files, not a general frontend file-size ceiling.
- `tests/architecture/no-direct-ws-send.test.ts:20-27` bans only `.send(JSON.stringify(` outside `server/bus.ts`; other raw sends or pre-serialized strings would not match.
- There is no `tests/architecture/command-table.test.ts` in the current tree, despite `CLAUDE.md` listing one as an invariant; exhaustiveness is compile-time in `server/commands/index.ts:11-14` and `64-114`.

Impact: the existing suite catches several important regressions, but not the highest-risk contract gaps: outbound schema coverage, shared purity/import direction, and all event producers using shared schemas.

Recommendation: add architecture tests for shared import purity, zod-at-boundary for outbound server events, event schema parity, and a general max-size or shrink-only rule for all large frontend files.

## Boundary Escape-Hatch Scan Summary

The requested grep found many `unknown as` and `as any` occurrences, mostly in tests and harness mocks. Boundary-relevant production hits include:

- `src/use-socket.ts:313`: envelope cast to `ServerMessage` after header-only validation.
- `src/Canvas.tsx:3373`, `3443`, `3515`, `3565`, `3613`, `3682`, `3708`: WS event payload casts in graph routing.
- `shared/render-dsl.ts:485`, `496`, `515`: render component casts caused by recursive schema limitations and patch merging.
- `shared/render-defaults.ts:103`: default-elision output cast back to `RenderComponent`.
- `server/render-tools.ts:60`, `186-191`: parse/cast and patch merge cast around render components.

No production `z.any()` was found in the reviewed surfaces; the code generally uses `z.unknown()` where untyped values are intentional. The issue is not widespread use of `any`, but unpaired casts at outbound boundaries.

## Top 5 Ranked Recommendations

1. Build a shared outbound WS event contract: `WsServerEvent` TypeScript union plus zod discriminated schemas, used by server producers and `useSocket`.
2. Add protocol negotiation: a `protocol_hello`/capabilities handshake so old clients and new servers can fail clearly or degrade intentionally.
3. Add `normalizedEventSchema` and validate harness translator output, persisted event hydration, and `sdk_event` payloads.
4. Harden render DSL recursion and patches: shared deep parser, post-patch validation, and parity tests for component type/default/renderer/flattening coverage.
5. Expand architecture tests to cover shared import direction, outbound zod-at-boundary, event schema parity, and stronger raw WS-send detection.
