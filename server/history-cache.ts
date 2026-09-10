import type { BufferedEvent } from "./session-host-config.ts";
import { fitsInline, HISTORY_EVENT_COUNT, HISTORY_PAGE_BYTES } from "../shared/history.ts";
export const HISTORY_GLOBAL_BYTES = 16 * 1024 * 1024;
export const HISTORY_GLOBAL_EVENTS = 32_000;
/** Shared LRU contains transcript bodies only; eviction never touches host state. */
const resident = new Map<HistoryBuffer, { events: BufferedEvent[]; sizes: number[]; bytes: number }>();
let bytes = 0, eventCount = 0;
export function historyCacheStats() {
  return { bytes, sessions: resident.size, events: eventCount };
}
export function evictHistoryCache(): void { resident.clear(); bytes = 0; eventCount = 0; }
export class HistoryBuffer {
  get events(): BufferedEvent[] {
    const entry = resident.get(this);
    if (!entry) return [];
    resident.delete(this); resident.set(this, entry);
    return entry.events.slice();
  }
  clear(): void {
    const entry = resident.get(this);
    if (entry) { bytes -= entry.bytes; eventCount -= entry.events.length; }
    resident.delete(this);
  }
  replace(events: BufferedEvent[]): void { this.clear(); for (const event of events) this.append(event); }
  append(event: BufferedEvent): void {
    // Live inline records may exceed the pessimistic 64 KiB estimate while
    // remaining under the actual wire limit; bound traversal by the cache budget.
    if (!fitsInline(event, HISTORY_PAGE_BYTES)) return;
    const encoded = JSON.stringify(event);
    const size = Buffer.byteLength(encoded);
    if (size > HISTORY_PAGE_BYTES) return;
    const entry = resident.get(this) ?? { events: [], sizes: [], bytes: 0 };
    resident.delete(this);
    entry.events.push(JSON.parse(encoded) as BufferedEvent); entry.sizes.push(size); entry.bytes += size; bytes += size; eventCount++;
    while (entry.events.length > HISTORY_EVENT_COUNT || entry.bytes > HISTORY_PAGE_BYTES) {
      const removed = entry.sizes.shift()!; entry.events.shift(); entry.bytes -= removed; bytes -= removed; eventCount--;
    }
    resident.set(this, entry);
    while (bytes > HISTORY_GLOBAL_BYTES || eventCount > HISTORY_GLOBAL_EVENTS) resident.keys().next().value!.clear();
  }
}
