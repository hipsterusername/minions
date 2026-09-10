import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPersistDb, closePersistDb } from "../../server/session-persist.ts";
import { appendEvent } from "../../server/session-repo.ts";
import { evictHistoryCache } from "../../server/history-cache.ts";

/** Every invocation owns a fresh synthetic database, including its cleanup. */
export function createArchiveFixture(count = 32) {
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error("Synthetic session count must be an integer between 1 and 1000");
  }
  const directory = mkdtempSync(join(tmpdir(), "minions-archive-test-"));
  const file = join(directory, "archive.db");
  const cleanup = () => {
    evictHistoryCache();
    closePersistDb();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const db = openPersistDb(file);
    const insert = db.prepare("INSERT INTO sessions (session_key, status, role) VALUES (?, 'completed', 'default')");
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const key = `fixture-session-${i}`;
        insert.run(key);
        for (let n = 0; n < 80; n++) appendEvent(db, key, "sdk_event", {
          type: "sdk_event", sessionKey: key, timestamp: n,
          event: { kind: "text", role: "assistant", id: `${i}-${n}`,
            text: `${i}:${n}:` + "abcdef漢😀".repeat(700) },
        });
      }
    })();
    closePersistDb();
    return { file, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
