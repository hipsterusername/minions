import type { WebSocket } from "ws";
/** Aggregate queue bound prevents many individually slow sockets multiplying residency. */
export const MAX_OUTBOUND_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOUND_MESSAGES = 4096;
let bytes = 0, messages = 0;
const queues = new WeakMap<WebSocket, { bytes: number; count: number; closed: boolean; onClose: () => void }>();
export function outboundQueueStats() { return { bytes, messages }; }
export function reserveOutbound(client: WebSocket, size: number): (() => void) | null {
  if (bytes + size > MAX_OUTBOUND_BYTES || messages >= MAX_OUTBOUND_MESSAGES) return null;
  let queue = queues.get(client);
  if (!queue) {
    queue = { bytes: 0, count: 0, closed: false, onClose: () => {} }; queues.set(client, queue);
    const captured = queue;
    queue.onClose = () => {
      bytes -= captured.bytes; messages -= captured.count;
      captured.bytes = 0; captured.count = 0; captured.closed = true;
    };
    client.once?.("close", queue.onClose);
  }
  if (queue.closed) return null;
  bytes += size; messages++; queue.bytes += size; queue.count++;
  let released = false;
  return () => {
    if (released || queue.closed) return;
    released = true; bytes -= size; messages--; queue.bytes -= size; queue.count--;
    if (queue.count === 0) { client.off?.("close", queue.onClose); queues.delete(client); }
  };
}
