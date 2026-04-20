/**
 * Typed WebSocket bus — Phase 2 replacement for ad-hoc `broadcast(wss, …)`
 * calls scattered across the server.
 *
 * Responsibilities:
 *   1. Wrap every outbound message in a `WsEnvelope` so the client can
 *      filter by topic (`session:<key>` / `project:<id>` / `global`).
 *   2. Keep transmission-side concerns — JSON encoding, client liveness,
 *      and per-client send errors — in one place.
 *
 * Non-goals (deliberately):
 *   - Server-side subscription registry. Clients filter on receipt; the
 *     server sends every envelope to every open socket. Per-socket
 *     topic routing is a follow-up if traffic becomes an issue.
 *   - Backpressure beyond what `ws` already provides. We log but do not
 *     drop messages when `bufferedAmount` grows; tune later if needed.
 *
 * The architecture fitness test in
 * `tests/architecture/no-direct-broadcast.test.ts` enforces that
 * `broadcast(` call sites are zero outside this file.
 */

import type { WebSocketServer, WebSocket } from "ws";
import {
  sessionTopic,
  projectTopic,
  GLOBAL_TOPIC,
  type Topic,
  type WsEnvelope,
} from "../shared/ws-envelope.ts";

// Re-export topic helpers so consumers only import from `./bus.ts`.
export { sessionTopic, projectTopic, GLOBAL_TOPIC, type Topic };

/** A payload is any JSON-serializable object with a `type` discriminator. */
export type BusPayload = { type: string } & Record<string, unknown>;

/**
 * Send one envelope to every open client connected to `wss`.
 *
 * Exported for tests; production code should prefer the topic-specific
 * helpers below so the call site documents who the message is for.
 */
export function broadcast(wss: WebSocketServer, envelope: WsEnvelope): void {
  const msg = JSON.stringify(envelope);
  for (const client of wss.clients) {
    // `ws` exposes a numeric readyState; 1 === OPEN without importing the
    // constant (server-side it's `WebSocket.OPEN` from the `ws` lib).
    if ((client as WebSocket).readyState === 1) {
      (client as WebSocket).send(msg);
    }
  }
}

function wrap(topic: Topic, payload: BusPayload): WsEnvelope {
  return { ...payload, topic };
}

export interface Bus {
  /** Send a pre-wrapped envelope (escape hatch — prefer `emitTo*`). */
  emit(envelope: WsEnvelope): void;

  /** Send an event scoped to a session. */
  emitToSession(sessionKey: string, payload: BusPayload): void;

  /** Send an event scoped to a project. */
  emitToProject(projectId: string, payload: BusPayload): void;

  /** Send an event every connected client should see. */
  emitGlobal(payload: BusPayload): void;
}

/**
 * Send one envelope to a single client (unicast). Use this for direct
 * replies to the requesting WebSocket — errors, acks, sync responses.
 *
 * Every outbound message (broadcast or unicast) must flow through an
 * envelope so the client's `wsEnvelopeSchema.safeParse` accepts it.
 */
export function unicast(
  ws: WebSocket,
  topic: Topic,
  payload: BusPayload,
): void {
  if ((ws as WebSocket).readyState === 1) {
    (ws as WebSocket).send(JSON.stringify(wrap(topic, payload)));
  }
}

/**
 * Convenience: unicast scoped to a session topic.
 */
export function unicastToSession(
  ws: WebSocket,
  sessionKey: string,
  payload: BusPayload,
): void {
  unicast(ws, sessionTopic(sessionKey), payload);
}

/**
 * Convenience: unicast with the global topic. Use for messages that
 * aren't scoped to any specific session (generic errors, session lists).
 */
export function unicastGlobal(ws: WebSocket, payload: BusPayload): void {
  unicast(ws, GLOBAL_TOPIC, payload);
}

/**
 * Create a bus bound to a specific `WebSocketServer`. The returned
 * object is stable for the lifetime of the server.
 */
export function createBus(wss: WebSocketServer): Bus {
  return {
    emit(envelope) {
      broadcast(wss, envelope);
    },
    emitToSession(sessionKey, payload) {
      broadcast(wss, wrap(sessionTopic(sessionKey), payload));
    },
    emitToProject(projectId, payload) {
      broadcast(wss, wrap(projectTopic(projectId), payload));
    },
    emitGlobal(payload) {
      broadcast(wss, wrap(GLOBAL_TOPIC, payload));
    },
  };
}
