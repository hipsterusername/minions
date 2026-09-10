import { fitsInline, HISTORY_INLINE_BYTES, isArchivePlaceholderText } from "../shared/history.ts";
import type { BufferedEvent } from "./session-host-config.ts";
import { persistenceDb, loadRecentEvents } from "./session-persist.ts";
import { readHistoryPreview, readHistoryFacts, type HistoryFacts } from "./session-history.ts";
interface Host { id: string; eventBuffer: BufferedEvent[] }
const facts = new WeakMap<Host, HistoryFacts>();
const projections = new WeakMap<object, BufferedEvent>();
export function historyProjection(event: object): object { return projections.get(event) ?? event; }
export function historyFactsForHost(host: Host): HistoryFacts {
  const cached = facts.get(host);
  if (cached) return cached;
  const db = persistenceDb();
  const value = db ? readHistoryFacts(db, host.id) : { lastActivityAt: null, lastResponseAt: null, lastSdkEventKind: null, lastEventType: null, hasAssistant: false };
  for (const event of host.eventBuffer) update(value, event);
  facts.set(host, value);
  return value;
}
function update(value: HistoryFacts, event: BufferedEvent): void {
  value.lastActivityAt = event.timestamp;
  value.lastEventType = event.type;
  value.lastSdkEventKind = event.type === "sdk_event" ? event.event?.kind ?? null : null;
  if (event.type === "sdk_event" && event.event?.kind === "text" && event.event.role === "assistant") {
    value.hasAssistant = true; value.lastResponseAt = event.timestamp;
  }
}
export function recordHistoryEvent(host: Host, event: BufferedEvent, id: number | null): BufferedEvent {
  update(historyFactsForHost(host), event);
  let retained = event;
  if (id !== null) {
    // The traversal estimate is deliberately pessimistic. Consult persisted bytes
    // before archiving so live delivery uses the same threshold as replay.
    const bytes = fitsInline(event) ? 0 : eventSize(host.id, id);
    retained = bytes <= HISTORY_INLINE_BYTES ? { ...event, historyId: id }
      : readHistoryPreview(persistenceDb()!, host.id, id, bytes);
    projections.set(event, retained);
  }
  return retained;
}
function eventSize(key: string, id: number): number {
  return (persistenceDb()?.prepare("SELECT length(CAST(payload AS BLOB)) bytes FROM event_log WHERE session_key = ? AND id = ?")
    .get(key, id) as { bytes: number } | undefined)?.bytes ?? 0;
}
export function resetHistoryFacts(host: Host): void { facts.delete(host); }
export function semanticHistory(host: Host): BufferedEvent[] {
  const events = persistenceDb() ? loadRecentEvents(host.id) : [];
  // Archive projections are display/navigation records, not conversation evidence.
  return (events.length ? events : host.eventBuffer ?? []).filter(event => !event.historyRef
    && !(event.event?.kind === "text" && event.event.role === "assistant" && isArchivePlaceholderText(event.event.text)));
}
