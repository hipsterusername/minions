import { expect, it, vi } from "vitest";
import { startRegisteredSession } from "./session-registry-start.ts";
import type { SessionHost, SessionHostDeps, StartSessionOptions } from "./session-host.ts";

it("acknowledges dispatch without waiting for the complete provider turn", async () => {
  let accept!: () => void;
  let end!: () => void;
  const host = { start: (_options: unknown, _deps: unknown, ready: () => void) => {
    accept = ready; return new Promise<void>(resolve => { end = resolve; });
  } } as unknown as SessionHost;
  const startup = startRegisteredSession(host, {} as StartSessionOptions, {} as SessionHostDeps);
  const delivered = vi.fn(); void startup.then(delivered);
  await Promise.resolve(); expect(delivered).not.toHaveBeenCalled();
  accept(); await startup; expect(delivered).toHaveBeenCalledOnce(); end();
});

it("rejects a startup failure that the host finalizer has already handled", async () => {
  const host = { lastError: "harness unavailable", start: vi.fn().mockResolvedValue(undefined) } as unknown as SessionHost;
  await expect(startRegisteredSession(host, {} as StartSessionOptions, {} as SessionHostDeps))
    .rejects.toThrow("harness unavailable");
});

it("publishes a visible failure when persistence interrupts the host error finalizer", async () => {
  const host = { id:"session",status:"running",start:vi.fn().mockRejectedValue(new Error("storage failed")) } as unknown as SessionHost;
  const emitToSession = vi.fn();
  startRegisteredSession(host, {} as StartSessionOptions, {bus:{emitToSession}} as unknown as SessionHostDeps);
  await Promise.resolve();
  expect(host.status).toBe("error");
  expect(emitToSession).toHaveBeenCalledWith("session", expect.objectContaining({type:"session_error",error:"storage failed"}));
});
