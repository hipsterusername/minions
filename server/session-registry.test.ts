/**
 * Tests for `SessionRegistry` — focused on the cap semantics and the
 * hydration round-trip that drives the post-Phase-4.4 regression.
 *
 * Background: a project that has accumulated N persisted sessions where
 * N === MAX_SESSIONS used to make every new `create_session` fail at
 * boot, because hydration filled the map but the cap counted on-disk
 * rows instead of live sessions. `activeCount()` is the fix; these
 * tests pin its semantics so the regression doesn't slip back in.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionRegistry } from "./session-registry.ts";
import { SessionHost } from "./session-host.ts";
import {
  closePersistDb,
  openPersistDb,
  persistSession,
  type PersistableSession,
} from "./session-persist.ts";

function tmpDb(): string {
  return path.join(
    os.tmpdir(),
    `minions-registry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function rmDb(p: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${p}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function makePersisted(
  overrides: Partial<PersistableSession> = {},
): PersistableSession {
  return {
    id: "sess-1",
    status: "idle",
    cwd: "/tmp/work",
    model: "sonnet",
    role: "leader",
    taskName: "Old work",
    sessionId: "sdk-uuid-1",
    worktreeIsolation: false,
    totalCost: 0.1,
    turns: 1,
    ...overrides,
  };
}

describe("SessionRegistry.activeCount", () => {
  it("returns 0 for an empty registry", () => {
    const r = new SessionRegistry();
    expect(r.activeCount()).toBe(0);
  });

  it("excludes hosts with status 'stopped'", () => {
    const r = new SessionRegistry();
    const h = new SessionHost("a", "/tmp");
    h.status = "stopped";
    // Reach into the internal map via `start` would require deps;
    // we use the public `entries()` shape via direct map insertion.
    (r as unknown as { map: Map<string, SessionHost> }).map.set("a", h);
    expect(r.activeCount()).toBe(0);
  });

  it("counts hosts with non-stopped statuses", () => {
    const r = new SessionRegistry();
    const map = (r as unknown as { map: Map<string, SessionHost> }).map;
    for (const [key, status] of [
      ["run", "running"],
      ["idle", "idle"],
      ["err", "error"],
      ["done", "completed"],
      ["off", "stopped"],
    ] as const) {
      const h = new SessionHost(key, "/tmp");
      h.status = status;
      map.set(key, h);
    }
    expect(r.activeCount()).toBe(4);
  });
});

describe("SessionRegistry.hydrateFromDb — sessionId round-trip", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    process.env["MINIONS_SERVER_DB"] = dbPath;
    closePersistDb();
    openPersistDb();
  });

  afterEach(() => {
    closePersistDb();
    delete process.env["MINIONS_SERVER_DB"];
    rmDb(dbPath);
  });

  it("restores host.sessionId from disk so resume can pass it as resumeId", () => {
    persistSession(makePersisted({ id: "leader-1", sessionId: "abc-123" }));
    const r = new SessionRegistry();
    r.hydrateFromDb();
    const host = r.get("leader-1");
    expect(host).toBeDefined();
    expect(host?.sessionId).toBe("abc-123");
  });

  it("hydrated sessions come back as 'stopped' so they don't count against the cap", () => {
    // Persist N === any cap and hydrate — activeCount should stay 0
    // because hydrated rows resurrect with status "stopped". This is
    // the exact scenario that broke NEW leader initiation: a populated
    // DB used to push registry.size up to MAX_SESSIONS instantly.
    for (let i = 0; i < 10; i++) {
      persistSession(makePersisted({ id: `leader-${i}`, sessionId: `s-${i}` }));
    }
    const r = new SessionRegistry();
    r.hydrateFromDb();
    expect(r.size).toBe(10);
    expect(r.activeCount()).toBe(0);
  });

  it("preserves null sessionId for pre-migration rows", () => {
    persistSession(makePersisted({ id: "old-leader", sessionId: null }));
    const r = new SessionRegistry();
    r.hydrateFromDb();
    expect(r.get("old-leader")?.sessionId).toBeNull();
  });
});
