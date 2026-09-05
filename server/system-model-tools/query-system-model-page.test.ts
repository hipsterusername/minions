import { describe, expect, it } from "vitest";
import { retrievalPage, digest, type RetrievalEntry } from "./query-system-model-page.ts";
import { normalizeQuery } from "./query-system-model-schema.ts";
import { createQuerySystemModelToolDef } from "./query-system-model.ts";
import { loadSystemModel } from "../system-model/load.ts";
import { copyValidFixtureWithSurfaces } from "../system-model/load.test.ts";

const snapshot = digest({ model: "test" });
const metadata = { operation: "read", status: "ok", modelVersion: snapshot, freshness: { status: "unknown", reason: "not_checked" } };
const input = { ids: ["capability.workspace_management"], facets: ["behavior"], maxResponseBytes: 2048 };

function drain(entries: RetrievalEntry[], args = input, meta = metadata) {
  const values = new Map<number, Record<string, unknown>>();
  const fragments = new Map<number, string>();
  let cursor: string | undefined;
  let pages = 0;
  let previous = [-1, -1];
  do {
    const result = retrievalPage(entries, meta, normalizeQuery({ ...args, cursor }), snapshot);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(args.maxResponseBytes);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.status).toBe(meta.status);
    for (const value of [...payload.matches, ...payload.diagnostics]) {
      expect(values.has(value.entryIndex)).toBe(false);
      values.set(value.entryIndex, value);
    }
    for (const fragment of payload.fragments) {
      const prior = fragments.get(fragment.entryIndex) ?? "";
      expect(fragment.offset).toBe(Array.from(prior).length);
      expect(fragment.nextOffset).toBe(fragment.offset + Array.from(fragment.text).length);
      expect(fragment.nextOffset).toBeGreaterThan(fragment.offset);
      const next = prior + fragment.text;
      fragments.set(fragment.entryIndex, next);
      if (fragment.nextOffset === fragment.totalCodePoints) {
        expect(values.has(fragment.entryIndex)).toBe(false);
        values.set(fragment.entryIndex, JSON.parse(next));
      }
    }
    cursor = payload.page.nextCursor;
    if (cursor) {
      const next = JSON.parse(Buffer.from(cursor, "base64url").toString());
      expect(next.i > previous[0]! || (next.i === previous[0] && next.o > previous[1]!)).toBe(true);
      previous = [next.i, next.o];
      expect(payload.page.complete).toBe(false);
    } else expect(payload.page.complete).toBe(true);
    expect(++pages).toBeLessThan(500);
  } while (cursor);
  expect([...values].sort(([a], [b]) => a - b).map(([, value]) => value)).toEqual(entries.map((entry, index) => ({ ...entry.value, entryIndex: index })));
  return { pages, fragments };
}

describe("bounded retrieval pages", () => {
  it.each([2048, 16384])("reconstructs complete entries and diagnostics at %i bytes", (maxResponseBytes) => {
    const huge = '🙂é"\\\n'.repeat(900);
    const entries: RetrievalEntry[] = [
      { target: "matches", value: { id: "first", facets: { behavior: { summary: "small" } } } },
      { target: "matches", value: { id: "second", facets: { behavior: { summary: huge, steps: Array(80).fill('"\\🙂') } } } },
      { target: "matches", value: { id: "third" } },
      { target: "diagnostics", value: { file: "model.yaml", message: huge } },
    ];
    const result = drain(entries, { ...input, maxResponseBytes });
    expect(result.pages).toBeGreaterThan(1);
    expect(result.fragments.size).toBe(2);
  });

  it("fragments enormous identities and parallel-edge metadata without clipping", () => {
    drain([{ target: "matches", value: { id: "x".repeat(9000), label: "🙂".repeat(1000),
      via: Array.from({ length: 50 }, (_, index) => ({ field: `bridges[${index}]`, reason: "a".repeat(200) })) } }]);
  });

  it("replays cursors and rejects changed requests, snapshots and invalid offsets", () => {
    const entries: RetrievalEntry[] = [{ target: "matches", value: { text: "🙂".repeat(1000) } }];
    const query = normalizeQuery(input);
    const first = JSON.parse(retrievalPage(entries, metadata, query, snapshot).content[0]!.text);
    const cursor = first.page.nextCursor as string;
    const next = { ...query, cursor };
    expect(retrievalPage(entries, metadata, next, snapshot)).toEqual(retrievalPage(entries, metadata, next, snapshot));
    const status = (args: typeof next, hash = snapshot) => JSON.parse(retrievalPage(entries, metadata, args, hash).content[0]!.text).status;
    expect(status({ ...next, topK: 1 })).toBe("invalid_cursor");
    expect(status({ ...next, maxResponseBytes: 16384 })).toBe("invalid_cursor");
    expect(status(next, digest({ model: "changed" }))).toBe("stale_cursor");
    for (const bad of ["!", "a".repeat(513), Buffer.from("{}").toString("base64url")]) expect(status({ ...next, cursor: bad })).toBe("invalid_cursor");
    const data = JSON.parse(Buffer.from(cursor, "base64url").toString());
    for (const patch of [{ o: -1 }, { o: 999999 }, { i: 100 }, { extra: true }]) {
      expect(status({ ...next, cursor: Buffer.from(JSON.stringify({ ...data, ...patch })).toString("base64url") })).toBe("invalid_cursor");
    }
  });

  it("rejects a fragment cursor for an ordinary entry", () => {
    const entries: RetrievalEntry[] = [{ target: "matches", value: { id: "a" } }, { target: "matches", value: { id: "b" } }];
    const query = normalizeQuery({ ...input, topK: 1 });
    const first = JSON.parse(retrievalPage(entries, metadata, query, snapshot).content[0]!.text);
    const data = JSON.parse(Buffer.from(first.page.nextCursor, "base64url").toString());
    const cursor = Buffer.from(JSON.stringify({ ...data, o: 1 })).toString("base64url");
    expect(JSON.parse(retrievalPage(entries, metadata, { ...query, cursor }, snapshot).content[0]!.text).status).toBe("invalid_cursor");
  });

  it("binds the complete loaded model and handles huge unavailable-model diagnostics", async () => {
    const project = copyValidFixtureWithSurfaces();
    const model = loadSystemModel(project).model!;
    model.capabilities[0]!.summary = "🙂".repeat(2000);
    const runtime = { mode: "advisory" as const, manifestFound: true, model, loadErrors: [] };
    const context = { leaderSessionKey: "test", cwd: project, projectPath: project, runtime,
      bus: { emit() {}, emitToSession() {}, emitToProject() {}, emitGlobal() {}, subscribe: () => () => {} } };
    const tool = createQuerySystemModelToolDef(context);
    const args = { ...input, facets: ["summary"] };
    const first = JSON.parse((await tool.handler(args)).content[0]!.text);
    expect(first.fragments).toHaveLength(1);
    model.policies.contextBudgets.perObjectSummary++;
    const changed = JSON.parse((await tool.handler({ ...args, cursor: first.page.nextCursor })).content[0]!.text);
    expect(changed.status).toBe("stale_cursor");
    const unavailable = createQuerySystemModelToolDef({ ...context,
      runtime: { ...runtime, model: null, loadErrors: [{ file: "bad.yaml", message: '"🙂\\'.repeat(3000) }] } });
    let cursor: string | undefined;
    let text = "";
    do {
      const result = await unavailable.handler({ query: "workspace", maxResponseBytes: 2048, cursor });
      expect(result.isError).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.status).toBe("model_unavailable");
      expect(payload.modelVersion).toBeUndefined();
      text += payload.fragments[0].text;
      cursor = payload.page.nextCursor;
    } while (cursor);
    expect(JSON.parse(text).message).toBe('"🙂\\'.repeat(3000));
  });

  it("hashes semantic objects consistently while preserving meaningful array order", () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
    drain([]);
  });
});
