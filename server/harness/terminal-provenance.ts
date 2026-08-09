import type { NormalizedEvent } from "../../shared/normalized-event.ts";
import type { HarnessRunControl } from "./types.ts";
import { persistenceDb } from "../session-persist.ts";
import type {
  InvocationTerminalKind,
  InvocationTerminalSource,
} from "../work-item-invocations.ts";
import { claimRunInvocationTerminal } from "../work-item-invocations.ts";

type DoneEvent = Extract<NormalizedEvent, { kind: "done" }>;

const provenance = new WeakMap<object, InvocationTerminalSource>();
export const HARNESS_DRAIN = Symbol("minions.harnessDrain");
export type DrainableHarnessControl = HarnessRunControl & {
  [HARNESS_DRAIN]?: Promise<void>;
};

export function tagTerminalProvenance<T extends DoneEvent>(
  event: T,
  source: InvocationTerminalSource,
): T {
  provenance.set(event, source);
  return event;
}

export function terminalProvenance(event: DoneEvent): InvocationTerminalSource {
  return provenance.get(event) ?? "adapter";
}

export function terminalKind(event: DoneEvent): InvocationTerminalKind {
  if (event.reason === "error") return "error";
  if (event.reason === "abort") return "cancelled";
  return "clean";
}

/** Persist a terminal the adapter observed while its outer consumer is aborting. */
export function persistAbortedHarnessTerminal(
  runKey: string,
  event: DoneEvent,
  at = Date.now(),
): boolean {
  const db = persistenceDb();
  if (!db) return false;
  const latest = db.prepare(`SELECT provider_generation FROM run_invocations
    WHERE run_key = ? ORDER BY provider_generation DESC LIMIT 1`)
    .get(runKey) as { provider_generation: number } | undefined;
  if (!latest) return false;
  return claimRunInvocationTerminal(db, {
    runKey,
    providerGeneration: latest.provider_generation,
    terminalKind: terminalKind(event),
    terminalSource: terminalProvenance(event),
    terminalAt: at,
  }).claimed;
}

export async function awaitHarnessDrain(
  control: HarnessRunControl | null,
  timeoutMs = 3_000,
): Promise<void> {
  const drain = (control as DrainableHarnessControl | null)?.[HARNESS_DRAIN];
  if (!drain) return;
  const timeout = AbortSignal.timeout(timeoutMs);
  await Promise.race([
    drain,
    new Promise<void>((resolve) =>
      timeout.addEventListener("abort", () => resolve(), { once: true })),
  ]);
}

export function trackHarnessDrain(
  events: AsyncIterable<NormalizedEvent>,
): { events: AsyncIterable<NormalizedEvent>; drain: Promise<void> } {
  let resolveDrain!: () => void;
  const drain = new Promise<void>((resolve) => { resolveDrain = resolve; });
  return {
    events: (async function* () {
      try {
        yield* events;
      } finally {
        resolveDrain();
      }
    })(),
    drain,
  };
}
