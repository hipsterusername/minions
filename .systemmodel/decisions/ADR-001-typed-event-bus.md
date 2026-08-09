---
id: decision.typed_event_bus
type: decision
title: Route server fan-out through the typed event bus
status: accepted
summary: Server-originated events use topic-aware typed bus publication and never broadcast directly from commands or tools.
evidence: [server/bus.ts, tests/architecture/no-direct-broadcast.test.ts]
---
# Route server fan-out through the typed event bus

Commands, services, and agent tools publish through `server/bus.ts`. This keeps topic routing, event envelopes, buffering, persistence, and replay behavior centralized and testable.

Direct WebSocket broadcast outside the bus is forbidden. Changes to event production must preserve contract tests and the architecture guard.
