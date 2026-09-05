import { EventEmitter } from "node:events";
import type { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_DRAIN_TIMEOUT_MS,
  MAX_CLIENT_BURST_BYTES,
  createBus,
  unicastGlobal,
} from "./bus.ts";

class BufferedClient extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  callbacks: Array<(error?: Error) => void> = [];
  send(message: string, callback: (error?: Error) => void): void {
    this.sent.push(message);
    this.bufferedAmount += Buffer.byteLength(message);
    this.callbacks.push(callback);
  }
  drain(): void {
    this.bufferedAmount = 0;
    for (const callback of this.callbacks.splice(0)) callback();
  }
  terminate(): void {
    this.readyState = 3;
    this.emit("close");
  }
  get socket(): WebSocket { return this as unknown as WebSocket; }
}

describe("WebSocket backpressure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function syncBurst(client: BufferedClient): void {
    const payload = { type: "sync_response", events: "x".repeat(3 * 1024 * 1024) };
    unicastGlobal(client.socket, payload);
    unicastGlobal(client.socket, payload);
  }

  it("delivers a burst of large sync replies and live events without disconnecting a draining client", () => {
    const client = new BufferedClient();
    syncBurst(client);
    const bus = createBus({ clients: new Set([client.socket]) } as WebSocketServer);
    bus.emitGlobal({ type: "session_status", status: "running" });
    expect(client.readyState).toBe(1);
    expect(client.sent.map(message => JSON.parse(message).type)).toEqual([
      "sync_response", "sync_response", "session_status",
    ]);
    vi.advanceTimersByTime(CLIENT_DRAIN_TIMEOUT_MS - 1);
    client.drain();
    vi.advanceTimersByTime(1);
    expect(client.readyState).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.listenerCount("close")).toBe(0);
  });

  it("disconnects a stalled client at the deadline even if no more messages arrive", () => {
    const client = new BufferedClient();
    syncBurst(client);
    vi.advanceTimersByTime(CLIENT_DRAIN_TIMEOUT_MS - 1);
    expect(client.readyState).toBe(1);
    vi.advanceTimersByTime(1);
    expect(client.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend a stalled client's deadline when more messages arrive", () => {
    const client = new BufferedClient();
    syncBurst(client);
    vi.advanceTimersByTime(CLIENT_DRAIN_TIMEOUT_MS - 1);
    unicastGlobal(client.socket, { type: "session_status" });
    vi.advanceTimersByTime(1);
    expect(client.readyState).toBe(3);
  });

  it("gives a later burst a fresh deadline after the previous burst drains", () => {
    const client = new BufferedClient();
    syncBurst(client);
    vi.advanceTimersByTime(CLIENT_DRAIN_TIMEOUT_MS - 1);
    client.drain();
    syncBurst(client);
    vi.advanceTimersByTime(1);
    expect(client.readyState).toBe(1);
    vi.advanceTimersByTime(CLIENT_DRAIN_TIMEOUT_MS - 1);
    expect(client.readyState).toBe(3);
  });

  it("enforces the hard memory bound immediately, including UTF-8 message bytes", () => {
    const client = new BufferedClient();
    syncBurst(client);
    client.bufferedAmount = MAX_CLIENT_BURST_BYTES - 100;
    const sentBefore = client.sent.length;
    unicastGlobal(client.socket, { type: "test", text: "😀".repeat(30) });
    expect(client.readyState).toBe(3);
    expect(client.sent).toHaveLength(sentBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the drain timer when a client closes", () => {
    const client = new BufferedClient();
    syncBurst(client);
    client.terminate();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.listenerCount("close")).toBe(0);
  });
});
