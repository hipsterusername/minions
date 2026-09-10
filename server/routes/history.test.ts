import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { createHistoryRoutes } from "./history.ts";
import { openPersistDb, closePersistDb } from "../session-persist.ts";
import { appendEvent } from "../session-repo.ts";
import { historyCookieToken, setHistoryCookie } from "../history-auth.ts";
afterEach(closePersistDb);
function handler(path: string) {
  const router = createHistoryRoutes() as unknown as { stack: { route: { path: string; stack: { handle: (req: Request, res: Response) => void }[] } }[] };
  return router.stack.find(r => r.route.path === path)!.route.stack[0]!.handle;
}
function response(stall = false) {
  const emitter = new EventEmitter();
  const chunks: Buffer[] = [];
  let status = 200; let body: unknown;
  const res = Object.assign(emitter, {
    destroyed: false, setHeader: () => res, type: () => res, setTimeout: () => res,
    sendStatus: (code: number) => { status = code; return res; },
    json: (value: unknown) => { body = value; if (!stall) emitter.emit("finish"); return res; },
    send: (value: unknown) => { body = value; if (!stall) emitter.emit("finish"); return res; },
    write: (chunk: Buffer) => { chunks.push(chunk); return !stall; },
    end: () => { emitter.emit("finish"); },
    destroy: () => { res.destroyed = true; emitter.emit("close"); },
  });
  return { res: res as unknown as Response, chunks, status: () => status, body: () => body };
}
const request = (params: Record<string, string>, query = {}) => ({ params, query }) as unknown as Request;
describe("authenticated bounded history HTTP contract", () => {
  it("caps slow page responses across clients and releases capacity on finish or close", () => {
    openPersistDb(":memory:");
    const run = handler("/:key");
    const stalled = Array.from({ length: 4 }, () => response(true));
    try {
      stalled.forEach(r => run(request({ key: "s" }, { format: "json" }), r.res));
      const rejected = response(); run(request({ key: "s" }), rejected.res);
      expect(rejected.status()).toBe(503);
      stalled[0]!.res.destroy();
      const accepted = response(); run(request({ key: "s" }), accepted.res);
      expect(accepted.status()).toBe(200);
      const next = response(); run(request({ key: "s" }), next.res);
      expect(next.status()).toBe(200);
    } finally { stalled.forEach(r => r.res.destroy()); }
  });
  it("renders escaped readable historical text with cursor and exact download links", () => {
    const db = openPersistDb(":memory:");
    for (let i = 0; i < 201; i++) appendEvent(db, "s", "sdk_event", { type: "sdk_event", sessionKey: "s", timestamp: i,
      event: { kind: "text", role: "assistant", text: "<script>alert(1)</script>" } });
    const r = response(); handler("/:key")(request({ key: "s" }), r.res);
    expect(r.body()).toContain("Older history"); expect(r.body()).toContain("/events/");
    expect(r.body()).toContain("&#60;script&#62;"); expect(r.body()).not.toContain("<script>");
  });
  it("streams exact UTF-8 with bounded chunks and caps stalled downloads globally", async () => {
    const db = openPersistDb(":memory:");
    const raw = { text: "😀漢".repeat(40_000) };
    const id = appendEvent(db, "s", "sdk_event", raw);
    const req = request({ key: "s", id: String(id) });
    const run = handler("/:key/events/:id");
    const stalled = Array.from({ length: 4 }, () => response(true));
    stalled.forEach(r => run(req, r.res));
    const rejected = response(); run(req, rejected.res); expect(rejected.status()).toBe(503);
    stalled.forEach(r => r.res.destroy());
    const r = response(); const done = new Promise<void>(resolve => r.res.once("finish", resolve)); run(req, r.res); await done;
    expect(Math.max(...r.chunks.map(c => c.length))).toBeLessThanOrEqual(65536);
    expect(Buffer.concat(r.chunks).toString()).toBe(JSON.stringify(raw));
  });
  it("limits link credentials to read-only archive routes", () => {
    const req = { method: "GET", originalUrl: "/api/history/s", headers: { cookie: "minions_history=secret" } } as Request;
    expect(historyCookieToken(req)).toBe("secret");
    expect(historyCookieToken({ ...req, method: "POST" } as Request)).toBeNull();
    expect(historyCookieToken({ ...req, originalUrl: "/api/files/save" } as Request)).toBeNull();
    let settings: unknown;
    setHistoryCookie(req, { cookie: (_name: string, _token: string, opts: unknown) => { settings = opts; } } as Response, "secret");
    expect(settings).toMatchObject({ path: "/api/history", httpOnly: true, sameSite: "strict" });
  });
});
