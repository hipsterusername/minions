/**
 * Turn bridge — decouples a planner run's completion from the orchestrator
 * awaiting it.
 *
 * The `dialectic-planner` agent type has no way to reach a specific
 * orchestrator instance, and the orchestrator does not want to reach into
 * SessionHost internals. This tiny module is the seam: the agent's
 * `onComplete` calls {@link resolveTurn} with the run's final assistant text,
 * and the orchestrator `await`s {@link awaitTurn} for the same session key.
 *
 * Orchestration is strictly sequential per planner (exactly one outstanding
 * turn per session key at a time), so a single-slot waiter map is sufficient.
 * A small `early` stash covers the (rare) case where completion is observed
 * before the orchestrator registered its waiter.
 */

export interface DialecticTurnResult {
  text: string;
  isError: boolean;
  /** Underlying failure reason when `isError` is true (surfaced to the user). */
  error?: string;
}

const waiters = new Map<string, (r: DialecticTurnResult) => void>();
const early = new Map<string, DialecticTurnResult>();

/** Await the next turn completion for a planner session key. */
export function awaitTurn(sessionKey: string): Promise<DialecticTurnResult> {
  const stashed = early.get(sessionKey);
  if (stashed) {
    early.delete(sessionKey);
    return Promise.resolve(stashed);
  }
  return new Promise<DialecticTurnResult>((resolve) => {
    waiters.set(sessionKey, resolve);
  });
}

/** Called from the planner agent's onComplete to unblock the orchestrator. */
export function resolveTurn(sessionKey: string, result: DialecticTurnResult): void {
  const waiter = waiters.get(sessionKey);
  if (waiter) {
    waiters.delete(sessionKey);
    waiter(result);
    return;
  }
  // Completion arrived before the awaiter registered — stash it.
  early.set(sessionKey, result);
}

/**
 * Abandon any pending waiter for a session key (stop/teardown). Resolves the
 * outstanding promise with an error sentinel so the orchestrator loop unwinds
 * instead of hanging.
 */
export function cancelTurn(sessionKey: string): void {
  const waiter = waiters.get(sessionKey);
  if (waiter) {
    waiters.delete(sessionKey);
    waiter({ text: "", isError: true, error: "Turn cancelled" });
  }
  early.delete(sessionKey);
}
