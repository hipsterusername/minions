import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerEvent = Record<string, unknown>;
type Listener = (event: WorkerEvent) => void;
type WindowClient = {
  url: string;
  focus(): Promise<void>;
  postMessage(message: unknown): void;
};

function loadWorker(windowClients: WindowClient[] = []) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const clients = {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => windowClients),
    openWindow,
  };
  const self = {
    location: { origin: "https://minions.example.test" },
    skipWaiting: vi.fn(),
    clients,
    registration: { showNotification },
    addEventListener(type: string, listener: Listener) { listeners.set(type, listener); },
  };
  vm.runInNewContext(fs.readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), {
    self,
    clients,
    URL,
  });
  return { listeners, showNotification, openWindow };
}

function waitableEvent(fields: WorkerEvent = {}) {
  let pending: Promise<unknown> = Promise.resolve();
  return {
    ...fields,
    waitUntil(value: Promise<unknown>) { pending = value; },
    done: () => pending,
  };
}

describe("mobile service worker", () => {
  it("shows a push payload with stable icons and session tag", async () => {
    const worker = loadWorker();
    const event = waitableEvent({
      data: { json: () => ({ title: "Approval", body: "Review", data: { sessionKey: "s1", url: "/m?session=s1" } }) },
    });
    worker.listeners.get("push")!(event);
    await event.done();
    expect(worker.showNotification).toHaveBeenCalledWith("Approval", {
      body: "Review",
      data: { sessionKey: "s1", url: "/m?session=s1" },
      tag: "s1",
      icon: "/icons/leader-active.svg",
      badge: "/icons/favicon.svg",
    });
  });

  it("focuses an existing mobile client and posts a same-origin route", async () => {
    const client: WindowClient = {
      url: "https://minions.example.test/m",
      focus: vi.fn(async () => undefined),
      postMessage: vi.fn(),
    };
    const worker = loadWorker([client]);
    const notification = { close: vi.fn(), data: { url: "/m?session=s1&review=1" } };
    const event = waitableEvent({ notification });
    worker.listeners.get("notificationclick")!(event);
    await event.done();
    expect(notification.close).toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith({ type: "push-navigate", url: "/m?session=s1&review=1" });
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.example/phish",
    "//attacker.example/phish",
    "/admin",
    "not a valid route",
  ])("falls back to /m for unsafe notification URL %s", async (url) => {
    const worker = loadWorker();
    const event = waitableEvent({ notification: { close: vi.fn(), data: { url } } });
    worker.listeners.get("notificationclick")!(event);
    await event.done();
    expect(worker.openWindow).toHaveBeenCalledWith("/m");
  });
});
