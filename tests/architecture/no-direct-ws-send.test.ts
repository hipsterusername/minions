/**
 * Architecture fitness — no direct `ws.send(JSON.stringify(...))` outside bus.
 *
 * Phase 2 added unicast helpers (`unicastToSession`, `unicastGlobal`) to
 * `server/bus.ts`. All server → client traffic — broadcast AND unicast —
 * must flow through the bus so every message includes a `topic` envelope
 * that the client's `wsEnvelopeSchema.safeParse` can validate.
 *
 * This test catches regressions where someone adds a new `ws.send(…)`
 * call directly instead of using the bus helpers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");

/** The only file allowed to contain raw `.send(JSON.stringify(` calls. */
const BUS_FILE = "server/bus.ts";

/**
 * Match `.send(JSON.stringify(` — the hallmark of a raw WebSocket send
 * that bypasses the bus envelope wrapping.
 */
const RAW_SEND_RE = /\.send\s*\(\s*JSON\.stringify\s*\(/g;

function listServerFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
  walk(SERVER_DIR);
  return out;
}

function countMatches(absPath: string, re: RegExp): number {
  const text = readFileSync(absPath, "utf8");
  return (text.match(re) ?? []).length;
}

describe("architecture: no direct ws.send(JSON.stringify(...)) outside server/bus.ts", () => {
  const files = listServerFiles().map((f) => ({
    path: f,
    rel: relative(REPO_ROOT, f).replace(/\\/g, "/"),
    count: countMatches(f, RAW_SEND_RE),
  }));

  for (const f of files.filter((x) => x.rel !== BUS_FILE)) {
    it(`${f.rel} has no raw ws.send(JSON.stringify(...)) call sites`, () => {
      expect(
        f.count,
        `${f.rel} has ${f.count} direct ws.send(JSON.stringify(...)) call site(s). ` +
          `Use unicastToSession(), unicastGlobal(), or bus.emitToSession() instead.`,
      ).toBe(0);
    });
  }
});
