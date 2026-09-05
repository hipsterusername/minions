import type { NormalizedToolDef } from "../harness/types.ts";
import { matchSystemModel } from "../system-model/match.ts";
import { discoveryEdges } from "../system-model/discovery-relations.ts";
import type { LoadedSystemModel } from "../system-model/types.ts";
import { clip, objectReference, preview, readFacets } from "./query-system-model-projection.ts";
import { digest, retrievalError, retrievalPage, type RetrievalEntry } from "./query-system-model-page.ts";
import { normalizeQuery, querySystemModelInputSchema, type Query } from "./query-system-model-schema.ts";
import type { SystemModelToolContext } from "./shared.ts";

export function createQuerySystemModelToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "query_system_model",
    description: "Discover model context progressively: search compact cards by query or files; read ids with selected facets; "
      + "expand ids through explicit relationships/direction. No automatic neighbors or packet/usage writes. "
      + "Repeat arguments with page.nextCursor for more. Oversized entries are JSON-string fragments: concatenate text by "
      + "entryIndex and code-point offset within the same request/model snapshot, then JSON.parse when nextOffset equals totalCodePoints. "
      + "Freshness is not checked; runtime packet requirements remain independent.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: querySystemModelInputSchema,
    handler: async (input: unknown) => {
      let query: Query;
      try { query = normalizeQuery(input); } catch {
        return retrievalError("invalid_request", "Use query_system_model with a non-empty query or files for search, or exact ids for read/expand. Check operation fields and size limits.");
      }
      const model = ctx.runtime.model;
      if (!model) return retrievalPage(ctx.runtime.loadErrors.map((error) => ({ target: "diagnostics", value: { ...error } })),
        { operation: query.operation, status: "model_unavailable" }, query, digest(ctx.runtime.loadErrors));
      const modelVersion = digest({ objects: [...model.objectsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
        manifest: model.manifest, policies: model.policies });
      const references = new Map([...model.objectsById.keys()].filter((id) => Buffer.byteLength(id) > 512)
        .map((id) => [objectReference(id, modelVersion), id]));
      const selectedIds = query.ids.map((id) => references.get(id) ?? id);
      const entries: RetrievalEntry[] = [];
      const metadata: Record<string, unknown> = { operation: query.operation, status: "ok", modelVersion,
        freshness: { status: "unknown", reason: "not_checked" } };
      const accepts = (type: string) => !query.objectTypes.length || query.objectTypes.some((item) => item === type);
      if (query.operation === "search") {
        const filtered = { ...model, objectsById: new Map([...model.objectsById].filter(([, object]) => accepts(object.type))) };
        // Rank before paging. Other matcher callers retain their existing topK behavior.
        const result = matchSystemModel({ model: filtered, request: query.query, files: query.files, topK: filtered.objectsById.size });
        for (const candidate of result.candidates) entries.push({ target: "matches", value: {
          ...preview(model.objectsById.get(candidate.id)!, model.policies.contextBudgets.perObjectSummary, modelVersion),
          score: candidate.score, reasons: candidate.reasons.slice(0, 3).map((reason) => clip(reason, 120)),
          ...(candidate.reasons.length > 3 ? { reasonsOmitted: candidate.reasons.length - 3 } : {}),
        } });
        metadata.status = entries.length ? "ok" : "no_matches";
        metadata.matchConfidence = result.matchConfidence;
        metadata.ranking = "lexical";
        metadata.fallbackInstruction = result.fallbackInstruction;
      } else if (query.operation === "read") {
        selectedIds.forEach((id, requestIndex) => {
          const object = model.objectsById.get(id);
          const value = !object ? { id, requestIndex, status: "missing" }
            : !accepts(object.type) ? { id, requestIndex, status: "type_excluded" }
              : { ...preview(object, model.policies.contextBudgets.perObjectSummary, modelVersion), requestIndex, status: "ok",
                source: { status: "unavailable" }, ...(query.facets.length ? { facets: readFacets(object, query.facets) } : {}) };
          entries.push({ target: "matches", value });
        });
      } else {
        entries.push(...expand(model, { ...query, ids: selectedIds }, modelVersion));
        metadata.status = entries.length ? "ok" : "no_matches";
      }
      return retrievalPage(entries, metadata, query, modelVersion);
    },
  };
}

function expand(model: LoadedSystemModel, query: Query, modelVersion: string): RetrievalEntry[] {
  const seeds = new Set(query.ids);
  const targets = new Map<string, Array<Record<string, unknown>>>();
  for (const edge of discoveryEdges(model)) {
    if (query.relationships.length && !query.relationships.includes(edge.relation)) continue;
    const matches = [
      ...(seeds.has(edge.source) && query.direction !== "in" ? [{ id: edge.target, direction: "out" }] : []),
      ...(seeds.has(edge.target) && query.direction !== "out" ? [{ id: edge.source, direction: "in" }] : []),
    ];
    for (const match of matches) {
      const object = model.objectsById.get(match.id)!;
      if (seeds.has(match.id) || (query.objectTypes.length && !query.objectTypes.includes(object.type))) continue;
      const reasons = targets.get(match.id) ?? [];
      reasons.push({ ...edge, direction: match.direction });
      targets.set(match.id, reasons);
    }
  }
  const results: RetrievalEntry[] = [...targets].sort(([a], [b]) => a.localeCompare(b)).map(([id, via]) => ({ target: "matches", value: {
    ...preview(model.objectsById.get(id)!, model.policies.contextBudgets.perObjectSummary, modelVersion), via,
  } }));
  query.ids.forEach((id, requestIndex) => {
    if (!model.objectsById.has(id)) results.push({ target: "diagnostics", value: { id, requestIndex, status: "missing" } });
  });
  return results;
}
