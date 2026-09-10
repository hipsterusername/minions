import { Router, type Response } from "express";
import { persistenceDb } from "../session-persist.ts";
import { readEventChunk, readHistoryPage } from "../session-history.ts";
const MAX_DOWNLOADS = 4;
let downloads = 0;
const pages = new Set<Response>();
const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
/** Registered behind the same authentication middleware as other private APIs. */
export function createHistoryRoutes(): Router {
  const router = Router();
  router.get("/:key", (req, res) => {
    const db = persistenceDb();
    if (!db) { res.sendStatus(503); return; }
    const before = req.query["before"] === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query["before"]);
    if (!Number.isSafeInteger(before) || before <= 0) { res.sendStatus(400); return; }
    // Bound complete page responses as well as streamed downloads: a slow
    // reader otherwise retains a page buffer for every concurrent request.
    if (pages.size >= 4) { res.setHeader("Retry-After", "1"); res.sendStatus(503); return; }
    pages.add(res);
    const release = () => { pages.delete(res); };
    res.once("close", release); res.once("finish", release);
    res.setTimeout(30_000, () => res.destroy());
    const page = readHistoryPage(db, req.params["key"]!, before);
    if (req.query["format"] === "json") { res.json(page); return; }
    const rows = page.events.map(event => {
      const ref = event.historyRef as { url: string } | undefined;
      const text = event.event?.kind === "text" ? event.event.text : JSON.stringify(event.event ?? event, null, 2);
      return `<article><pre>${escape(text)}</pre><a href="${escape(ref?.url ?? `${page.history.url}/events/${event.historyId}`)}">Exact event JSON</a></article>`;
    }).join("");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Session history</title><style>body{max-width:70em;margin:2em auto;font:16px sans-serif}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-bottom:1px solid #aaa;padding:1em}</style><h1>Session history</h1>${page.history.before ? `<a href="${escape(page.history.url)}?before=${page.history.before}">Older history</a>` : "Beginning of history"}${rows}`);
  });
  router.get("/:key/events/:id", (req, res) => {
    const id = Number(req.params["id"]);
    if (!Number.isSafeInteger(id) || id <= 0) { res.sendStatus(400); return; }
    if (downloads >= MAX_DOWNLOADS) { res.setHeader("Retry-After", "1"); res.sendStatus(503); return; }
    const db = persistenceDb();
    if (!db) { res.sendStatus(503); return; }
    const key = req.params["key"]!;
    let offset = 0;
    let chunk = readEventChunk(db, key, id, offset);
    if (chunk === null) { res.sendStatus(404); return; }
    downloads++;
    let released = false;
    const release = () => { if (!released) { released = true; downloads--; } };
    res.once("close", release); res.once("finish", release);
    res.setHeader("Content-Disposition", `attachment; filename="event-${id}.json"`);
    res.type("json");
    res.setTimeout(30_000, () => res.destroy());
    const pump = () => {
      try {
        if (res.destroyed) return;
        // One chunk per turn: bounds native/JS allocation and lets control traffic run.
        if (chunk === null) { res.destroy(); return; }
        if (!chunk.length) { res.end(); return; }
        offset += chunk.length;
        const ready = res.write(chunk);
        chunk = null;
        const next = () => { if (res.destroyed) return; chunk = readEventChunk(db, key, id, offset); pump(); };
        if (ready) setImmediate(next); else res.once("drain", next);
      } catch { res.destroy(); }
    };
    pump();
  });
  return router;
}
