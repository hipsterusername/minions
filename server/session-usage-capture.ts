import type { NormalizedEvent } from "../shared/normalized-event.ts";
import type { SessionHost } from "./session-host.ts";
import { persistSessionUsage } from "./session-persist.ts";
import { isTokenUsageSource, type SessionUsageTotals } from "./usage-telemetry.ts";

interface CapturedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUSD: number | null;
  countsTokens: boolean;
}

const capturedUsageByHost = new WeakMap<SessionHost, Map<string, CapturedUsage>>();

export function captureUsageEvent(
  host: SessionHost,
  event: Extract<NormalizedEvent, { kind: "usage" }>,
  timestamp: number,
): void {
  const source = event.source ?? "assistant";
  const usageIdentity = event.messageId ?? event.turnId ?? "";
  const eventKey = usageEventKey(host, event, usageIdentity);
  const captured = capturedUsageByHost.get(host) ?? new Map<string, CapturedUsage>();
  capturedUsageByHost.set(host, captured);

  const next = capturedUsage(event);
  const previous = captured.get(eventKey);
  if (previous && sameCapturedUsage(previous, next)) return;
  captured.set(eventKey, next);

  host.usageTotals = applyUsageDelta(host.usageTotals, previous, next);
  persistSessionUsage({
    sessionKey: host.id,
    role: host.role,
    model: host.model,
    source,
    messageId: event.messageId,
    turnId: event.turnId,
    sdkSessionId: event.sdkSessionId ?? host.sessionId ?? undefined,
    usageIdentity,
    input: event.input,
    output: event.output,
    cacheRead: event.cacheRead,
    cacheCreation: event.cacheCreation,
    costUSD: event.costUSD,
    timestamp,
  });
  if (event.costUSD != null) host.totalCost = event.costUSD;
}

function usageEventKey(
  host: SessionHost,
  event: Extract<NormalizedEvent, { kind: "usage" }>,
  usageIdentity: string,
): string {
  const source = event.source ?? "assistant";
  const sdkSessionId = event.sdkSessionId ?? host.sessionId ?? "";
  if (usageIdentity) {
    return JSON.stringify([host.id, sdkSessionId, source, usageIdentity]);
  }
  return JSON.stringify([
    host.id,
    sdkSessionId,
    host.role,
    host.model,
    source,
    event.input,
    event.output,
    event.cacheRead ?? 0,
    event.cacheCreation ?? 0,
    event.costUSD ?? null,
  ]);
}

function capturedUsage(event: Extract<NormalizedEvent, { kind: "usage" }>): CapturedUsage {
  return {
    input: event.input,
    output: event.output,
    cacheRead: event.cacheRead ?? 0,
    cacheCreation: event.cacheCreation ?? 0,
    costUSD: event.costUSD ?? null,
    countsTokens: isTokenUsageSource(event.source),
  };
}

function sameCapturedUsage(a: CapturedUsage, b: CapturedUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheCreation === b.cacheCreation &&
    a.costUSD === b.costUSD &&
    a.countsTokens === b.countsTokens
  );
}

function applyUsageDelta(
  totals: SessionUsageTotals,
  previous: CapturedUsage | undefined,
  next: CapturedUsage,
): SessionUsageTotals {
  const prev = previous?.countsTokens ? previous : null;
  const add = next.countsTokens ? next : null;
  const input = totals.input - (prev?.input ?? 0) + (add?.input ?? 0);
  const output = totals.output - (prev?.output ?? 0) + (add?.output ?? 0);
  const cacheRead = totals.cacheRead - (prev?.cacheRead ?? 0) + (add?.cacheRead ?? 0);
  const cacheCreation =
    totals.cacheCreation - (prev?.cacheCreation ?? 0) + (add?.cacheCreation ?? 0);
  const denominator = input + cacheRead;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    cacheHitRate: denominator > 0 ? cacheRead / denominator : 0,
  };
}
