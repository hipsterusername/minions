/** Run: node --expose-gc --import ./scripts/register-typescript.mjs tests/stability/history-memory.mjs <eager|lazy> [synthetic-session-count] */
import Database from "better-sqlite3";
import { openPersistDb, hydrateSessionsFromDb } from "../../server/session-persist.ts";
import { HistoryBuffer, historyCacheStats } from "../../server/history-cache.ts";
import { readHistoryPage } from "../../server/session-history.ts";
import { createArchiveFixture } from "./archive-fixture.mjs";
const [mode, countText] = process.argv.slice(2);
if (!["eager", "lazy"].includes(mode)) throw new Error("Use eager|lazy and an optional synthetic session count");
if (!global.gc) throw new Error("Run with --expose-gc");
const { file, cleanup } = createArchiveFixture(countText === undefined ? 32 : Number(countText));
let eagerDb;
try {
  global.gc();
  const before = process.memoryUsage();
  const db = mode === "eager" ? (eagerDb = new Database(file, { readonly: true, fileMustExist: true })) : openPersistDb(file);
  const keys = (db.prepare("SELECT session_key FROM sessions").all()).map(r => r.session_key);
  const roots = [];
  if (mode === "eager") {
    for (const key of keys) roots.push((db.prepare("SELECT payload FROM event_log WHERE session_key = ? ORDER BY id DESC LIMIT 200")
      .all(key)).map(row => JSON.parse(row.payload)));
  } else roots.push(hydrateSessionsFromDb());
  global.gc();
  const boot = process.memoryUsage();
  const samples = [];
  if (mode === "lazy") {
    const buffers = keys.map(() => new HistoryBuffer()); roots.push(buffers);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < keys.length; i++) buffers[i].replace(readHistoryPage(db, keys[i]).events);
      await new Promise(resolve => setImmediate(resolve)); global.gc();
      await new Promise(resolve => setImmediate(resolve)); global.gc(); samples.push({ pass, heapMiB: process.memoryUsage().heapUsed / 2 ** 20, ...historyCacheStats() });
    }
  }
  console.log(JSON.stringify({ mode, sessions: keys.length, bootHeapMiB: boot.heapUsed / 2 ** 20,
    retainedBootMiB: (boot.heapUsed - before.heapUsed) / 2 ** 20, rssMiB: boot.rss / 2 ** 20,
    samples, roots: roots.length }, null, 2));
} finally {
  try { eagerDb?.close(); } finally { cleanup(); }
}
