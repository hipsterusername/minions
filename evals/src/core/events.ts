import { locked } from "./durable.js";
import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { RunEventSchema, type RunEvent } from "../../schemas/index.js";

/** Append-only JSONL event ledger with stable event-id de-duplication on recovery. */
export class EventStore {
  constructor(readonly path: string) {}
  async append(event: Omit<RunEvent, "sequence">): Promise<RunEvent> {
    return locked(this.path, async () => {
    const bytes = await readFile(this.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return Buffer.alloc(0); });
    if (bytes.length && bytes.at(-1) !== 10) await truncate(this.path, bytes.lastIndexOf(10) + 1);
    const existing = await this.read();
    const duplicate = existing.find((item) => item.eventId === event.eventId);
    if (duplicate) return duplicate;
    const stored = RunEventSchema.parse({ ...event, sequence: existing.length ? existing.at(-1)!.sequence + 1 : 0 });
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, "a");
    try { await file.writeFile(`${JSON.stringify(stored)}\n`); await file.sync(); } finally { await file.close(); }
    return stored;
    });
  }
  async read(afterSequence = -1): Promise<readonly RunEvent[]> {
    try { return (await readFile(this.path, "utf8")).split("\n").slice(0,-1).filter(Boolean).map((line) => RunEventSchema.parse(JSON.parse(line))).filter((event) => event.sequence > afterSequence); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
}
