import type { SessionHost, SessionHostDeps, StartSessionOptions } from "./session-host.ts";

/** Observe errors even when persistence interrupts the host's error finalizer. */
export function startRegisteredSession(host: SessionHost, options: StartSessionOptions, deps: SessionHostDeps): void {
  void host.start(options, deps).catch((error: unknown) => {
    host.status = "error";
    host.lastError = error instanceof Error ? error.message : String(error);
    deps.bus.emitToSession(host.id, {
      type: "session_error", sessionKey: host.id, code: "SESSION_START_FAILED",
      error: host.lastError, timestamp: Date.now(),
    });
  });
}
