import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "./db.ts";
import { loadOrCreateVapidKeys } from "./push-vapid.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadOrCreateVapidKeys", () => {
  it("persists one valid key pair and reuses it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-vapid-"));
    dirs.push(dir);
    const db = initDb(path.join(dir, "push.db"));
    const first = loadOrCreateVapidKeys(db);
    expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(first.publicKey, "base64url")[0]).toBe(4);
    expect(Buffer.from(first.privateKey, "base64url").length).toBeGreaterThan(100);
    expect(loadOrCreateVapidKeys(db)).toEqual(first);
    expect((db.prepare("SELECT count(*) AS count FROM push_vapid").get() as { count: number }).count).toBe(1);
    db.close();
  });
});
