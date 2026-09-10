import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { expect, it } from "vitest";
import { reserveOutbound, outboundQueueStats, MAX_OUTBOUND_BYTES, MAX_OUTBOUND_MESSAGES } from "./transport-budget.ts";
it("bounds aggregate bytes/count and releases exactly once on completion or close", () => {
  const a = new EventEmitter() as WebSocket, b = new EventEmitter() as WebSocket;
  const release = reserveOutbound(a, MAX_OUTBOUND_BYTES)!;
  expect(reserveOutbound(b, 1)).toBeNull();
  a.emit("close"); release(); expect(outboundQueueStats()).toEqual({ bytes: 0, messages: 0 });
  for (let i = 0; i < MAX_OUTBOUND_MESSAGES; i++) expect(reserveOutbound(b, 1)).not.toBeNull();
  expect(reserveOutbound(b, 1)).toBeNull(); b.emit("close");
  expect(outboundQueueStats()).toEqual({ bytes: 0, messages: 0 });
});
