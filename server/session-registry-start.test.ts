import { expect, it, vi } from "vitest";
import { startRegisteredSession } from "./session-registry-start.ts";
import type { SessionHost, SessionHostDeps, StartSessionOptions } from "./session-host.ts";

it("publishes a visible failure when persistence interrupts the host error finalizer", async () => {
  const host = { id:"session",status:"running",start:vi.fn().mockRejectedValue(new Error("storage failed")) } as unknown as SessionHost;
  const emitToSession = vi.fn();
  startRegisteredSession(host, {} as StartSessionOptions, {bus:{emitToSession}} as unknown as SessionHostDeps);
  await Promise.resolve();
  expect(host.status).toBe("error");
  expect(emitToSession).toHaveBeenCalledWith("session", expect.objectContaining({type:"session_error",error:"storage failed"}));
});
