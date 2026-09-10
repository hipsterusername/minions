import type { SessionHost, SessionHostDeps, StartSessionOptions } from "./session-host.ts";

/** Observe errors even when persistence interrupts the host's error finalizer. */
export function startRegisteredSession(host: SessionHost, options: StartSessionOptions, deps: SessionHostDeps): Promise<void> {
  let dispatched!: () => void;
  let failed!: (error: unknown) => void;
  const startup = new Promise<void>((resolve, reject) => { dispatched = resolve; failed = reject; });
  // Existing fire-and-forget callers remain safe; wake callers await this same
  // promise and cannot acknowledge work rejected during asynchronous startup.
  void startup.catch(() => {});
  const needsAcceptance = options.continuitySource === "system";
  void host.start(options, deps, needsAcceptance ? undefined : dispatched,
    needsAcceptance ? dispatched : undefined).then(() => {
    failed(new Error(host.lastError ?? "Session ended before provider dispatch"));
  }, (error: unknown) => {
    failed(error);
    host.status = "error";
    host.lastError = error instanceof Error ? error.message : String(error);
    deps.bus.emitToSession(host.id, {
      type: "session_error", sessionKey: host.id, code: "SESSION_START_FAILED",
      error: host.lastError, timestamp: Date.now(),
    });
  });
  return startup;
}
