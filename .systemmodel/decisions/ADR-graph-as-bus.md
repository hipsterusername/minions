---
id: decision.graph_as_bus
type: decision
status: accepted
summary: Canvas sessions, command dispatch, and live UI updates route state changes through typed graph/bus edges instead of ad-hoc channels.
---
# Graph as Bus

Minions treats the canvas graph and typed WebSocket bus as the coordination
surface between leaders, minions, UI nodes, dashboards, and approval controls.
Server code emits typed envelopes through `server/bus.ts`; clients and
in-process subscribers react to those envelopes instead of reaching across
subsystem boundaries.

Consequences:

- Shared contracts that cross server/client boundaries live in `shared/`.
- New WebSocket commands must be registered in `server/commands/index.ts`.
- Outbound server events must flow through bus helpers so the client can parse
  and filter envelopes consistently.
