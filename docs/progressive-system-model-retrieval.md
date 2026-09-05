# Progressive system-model retrieval

Leaders can discover architecture context without creating a Work Packet. Search
suggests candidates; opening selected facets establishes interest; expansion
follows selected relationships. File-based execution requirements remain separate.

```js
query_system_model({ query: "leader context retrieval", topK: 3 })
query_system_model({ operation: "read", ids: ["capability.system_model_guidance"], facets: ["entryPoints"] })
query_system_model({ operation: "expand", ids: ["capability.system_model_guidance"], relationships: ["constraint"], direction: "out" })
```

Search accepts a question, repository-relative `files` ranking hints, or both.
`objectTypes` narrows result types. It returns compact cards with stable IDs,
previews, match reasons and available facets. It never automatically opens linked
objects or injects global constraints. Lexical confidence describes ranking, not
agent-confirmed relevance or correctness.

Omitting `operation` selects `read` when `ids` is nonempty, otherwise `search`.
Existing query and ID calls remain accepted, including legacy ID precedence over
a query. The old automatic `linked` results are intentionally removed; `linked`
is now empty. Explicit `expand` retrieves actual one-hop references with field,
source, target and direction provenance. It preserves parallel relationships and
cross-domain bridge eligibility. Declared constraint references are navigation,
not a complete applicability verdict.

A read without facets returns a preview. Explicit facets return complete selected
values: `summary`, `entryPoints`, `files`, `tests`, `behavior`, `decisions`, or
`constraints`. Cards advertise supported facets; unsupported pairs return
`unavailable`, modeled empty arrays remain available. Read preserves requested ID
order and duplicates, and reports missing/type-excluded slots. IDs remain intact;
when a model ID exceeds the 512-byte input limit, its card includes a short `ref`
that can be passed in `ids`. References expire when the loaded snapshot changes.

## Bounded responses and continuation

`topK` is page size (default 5, capped at 10), not a ceiling on reachable results.
Repeat the original arguments with `page.nextCursor` until `page.complete` is true.
Cursors bind normalized arguments, page settings, and the loaded model snapshot.
Stale or incompatible cursors return a restart instruction. Retrieval does not
persist selections, results, packets, or usage records.

`maxResponseBytes` defaults to 16384 and accepts 2048–16384. The exact bound is:

```js
Buffer.byteLength(JSON.stringify(normalizedToolResult), "utf8") <= maxResponseBytes
```

This includes the content/text wrapper and nested JSON escaping. It applies to
handler results, including handled errors and paged model-load diagnostics. It
excludes JSON-RPC/provider envelopes and schema errors generated before the handler.

Normal entries stay structured. An entry too large for an empty page appears in
`fragments`, with `entryIndex`, `target`, `encoding: "json-string"`, `offset`,
`nextOffset`, `totalCodePoints`, and `text`. Concatenate contiguous fragments for
the same request/snapshot and entry index, then `JSON.parse` once the last offset
reaches `totalCodePoints`. Offsets count Unicode code points in the serialized
entry, including JSON syntax. Do not mix streams. Completed entries are not emitted
again. Preview clipping is marked; request the full facet to recover its content.

## Freshness and execution

`modelVersion` identifies canonical loaded model content, not Git HEAD or live code
freshness. Reads report backing source as unavailable and freshness as not checked.
File/test facets and declared decision document paths remain useful navigation
hints. Inspect code and use the existing freshness tool when needed.

Runtime packet applicability, assignment enforcement, packet compilation,
verification, and reconciliation are unchanged. A query cannot waive requirements
or make a model object part of an implementation scope. Historical query-usage rows
remain untouched; existing health metrics can still include that older exposure.

New sessions initialized on the updated server receive the new schema and prompt.
No mid-run tool-schema refresh is promised; an old cached schema may accept old
query/ID calls but cannot advertise new facets or cursors.

## Design review and validation

A two-round proposer/critic dialectic settled input compatibility without a legacy
neighbor adapter, selected complete facets, isolated discovery relationships,
stateless lossless continuation, honest snapshot provenance, and handler-result
byte bounds. Persistent selection infrastructure, eager freshness scans, loader
source maps, and transport-wide validation changes were deferred.

On the task-start model, the same three-result query fell from 7004 to 2083 payload
bytes (about 70% less), with automatic neighbors falling from 27 to zero. This is
one representative measurement, not a general performance guarantee. Regression
coverage exercises full pagination/reassembly, Unicode and escaping, missing IDs,
all facet types and relationship families, unchanged packet applicability, and
compact prompts. Independent review also caught and verified the long-ID reference
case.
