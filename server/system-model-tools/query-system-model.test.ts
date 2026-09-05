import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { copyValidFixtureWithSurfaces } from "../system-model/load.test.ts";
import { createQuerySystemModelToolDef } from "./query-system-model.ts";
import { computePacketApplicability } from "../system-model/applicability.ts";
import { findWorkspaceBySource } from "../workspace-registry.ts";

const capabilityId = "capability.workspace_management";
function fixture() {
  const project = copyValidFixtureWithSurfaces();
  const model = loadSystemModel(project).model!;
  const tool = createQuerySystemModelToolDef({ leaderSessionKey: "retrieval-test", projectPath: project, cwd: project,
    runtime: { mode: "advisory", manifestFound: true, model, loadErrors: [] },
    bus: { emit() {}, emitToSession() { throw new Error("Retrieval must not emit mutations"); }, emitToProject() {}, emitGlobal() {}, subscribe: () => () => {} },
  });
  const query = async (input: unknown) => JSON.parse((await tool.handler(input)).content[0]!.text);
  return { project, model, tool, query };
}

describe("progressive query_system_model", () => {
  it("defaults to compact search without neighbors, even global constraints", async () => {
    const { query, model } = fixture();
    const global = { ...model.constraints[0]!, id: "constraint.global", scope: "global" as const, guards: [] };
    model.objectsById.set(global.id, global);
    const response = await query({ query: "workspace", objectTypes: ["capability"] });
    expect(response.operation).toBe("search");
    expect(response.matches).toHaveLength(1);
    expect(response.matches[0]).toMatchObject({ id: capabilityId, availableFacets: expect.arrayContaining(["entryPoints", "files"]) });
    expect(response.linked).toEqual([]);
    expect(response.matches[0].facets).toBeUndefined();
    expect(response.freshness).toEqual({ status: "unknown", reason: "not_checked" });
    expect(response.modelVersion).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves exact read order, duplicates, missing and type-excluded slots", async () => {
    const { query } = fixture();
    const response = await query({ query: "ignored legacy query", ids: [capabilityId, "unknown", "surface.mobile", capabilityId], objectTypes: ["capability"] });
    expect(response.operation).toBe("read");
    expect(response.matches.map((row: { requestIndex: number; status: string }) => [row.requestIndex, row.status])).toEqual([
      [0, "ok"], [1, "missing"], [2, "type_excluded"], [3, "ok"],
    ]);
    expect(response.matches[0].score).toBeUndefined();
    expect(response.matches[0].facets).toBeUndefined();
    expect(response.linked).toEqual([]);
  });

  it("opens only requested facets, keeping declared constraints as references", async () => {
    const { query, model } = fixture();
    const response = await query({ operation: "read", ids: [capabilityId], facets: ["entryPoints", "constraints"] });
    expect(response.matches[0].facets).toEqual({ entryPoints: { status: "ok", value: model.capabilities[0]!.entryPoints },
      constraints: { status: "ok", value: model.capabilities[0]!.constraints } });
    expect(response.matches[0].source).toEqual({ status: "unavailable" });
    expect(response.linked).toEqual([]);
    const unsupported = await query({ ids: ["surface.mobile"], facets: ["entryPoints"] });
    expect(unsupported.matches[0].facets.entryPoints).toEqual({ status: "unavailable", reason: "not_modeled" });
  });

  it("expands typed one-hop edges with direction and target-type filters", async () => {
    const { query, model } = fixture();
    const response = await query({ operation: "expand", ids: [capabilityId], relationships: ["entry_point"], direction: "out", objectTypes: ["surface"] });
    expect(response.matches.map((row: { id: string }) => row.id)).toEqual(["surface.canvas", "surface.mobile"]);
    expect(response.matches[0].via[0]).toMatchObject({ source: capabilityId, target: "surface.canvas", relation: "entry_point", direction: "out" });
    const inverse = await query({ operation: "expand", ids: ["surface.mobile"], direction: "in", relationships: ["entry_point"] });
    expect(inverse.matches[0]).toMatchObject({ id: capabilityId, via: [expect.objectContaining({ direction: "in" })] });
    const global = { ...model.constraints[0]!, id: "constraint.unrelated_global", scope: "global" as const, guards: [], appliesTo: { capabilities: [], flows: [], surfaces: [], files: [] } };
    model.objectsById.set(global.id, global);
    const expansion = await query({ operation: "expand", ids: [capabilityId], topK: 10 });
    expect(expansion.matches.some((row: { id: string }) => row.id === global.id)).toBe(false);
    const missing = await query({ operation: "expand", ids: ["missing"] });
    expect(missing.diagnostics).toEqual([expect.objectContaining({ id: "missing", status: "missing" })]);
  });

  it("uses normalized files-only ranking without changing authoritative applicability", async () => {
    const { query, model } = fixture();
    const before = computePacketApplicability(model, ["server/example.ts"]);
    const response = await query({ files: ["./server\\example.ts"] });
    expect(response.matches.length).toBeGreaterThan(0);
    expect(response.matches[0].reasons.join(" ")).toContain("file");
    expect(computePacketApplicability(model, ["server/example.ts"])).toEqual(before);
    expect(before.packetRequired).toBe(true);
    expect(computePacketApplicability(model, ["README.md"]).packetRequired).toBe(false);
  });

  it("caps page size and makes results beyond topK reachable", async () => {
    const { query, model } = fixture();
    for (let index = 0; index < 13; index++) model.objectsById.set(`risk.extra_${index}`, {
      id: `risk.extra_${index}`, type: "risk", domain: "domain.workspace", summary: `needle ${index}`, severity: "low",
      appliesTo: { capabilities: [], flows: [], surfaces: [], files: [] },
    });
    const first = await query({ query: "needle", topK: 99 });
    expect(first.matches).toHaveLength(10);
    const second = await query({ query: "needle", topK: 99, cursor: first.page.nextCursor });
    expect(second.matches).toHaveLength(3);
    expect(new Set([...first.matches, ...second.matches].map((row) => row.id)).size).toBe(13);
    expect(second.page.complete).toBe(true);
    expect(second.page.nextCursor).toBeUndefined();
  });

  it("marks clipped previews and allows the complete summary to be opened", async () => {
    const { query, model } = fixture();
    const object = model.capabilities[0]!;
    object.summary = "🙂".repeat(400);
    model.policies.contextBudgets.perObjectSummary = 2;
    const response = await query({ ids: [capabilityId] });
    expect(response.matches[0].summary).toBe("🙂".repeat(5) + "...");
    expect(response.matches[0].previewTruncated).toContain("summary");
    const opened = await query({ ids: [capabilityId], facets: ["summary"] });
    expect(opened.matches[0].facets.summary.value).toBe(object.summary);
  });

  it("returns an ordinary empty fallback and performs no retrieval database writes", async () => {
    const { query, project } = fixture();
    const registeredBefore = findWorkspaceBySource(project);
    const response = await query({ query: "zzzxxyy" });
    expect(response).toMatchObject({ status: "no_matches", matches: [], linked: [], page: { complete: true }, matchConfidence: "low" });
    expect(response.fallbackInstruction).toBe("inspect repo; ask only if required");
    await query({ query: "workspace" });
    await query({ ids: [capabilityId], facets: ["behavior"] });
    await query({ operation: "expand", ids: [capabilityId] });
    expect(findWorkspaceBySource(project)).toEqual(registeredBefore);
    expect(registeredBefore).toBeNull();
  });

  it.each([
    {}, { query: " " }, { objectTypes: ["capability"] }, { operation: "read" },
    { operation: "search", ids: [capabilityId], query: "workspace" },
    { operation: "read", ids: [capabilityId], query: "workspace" },
    { query: "workspace", facets: ["summary"] }, { ids: [capabilityId], direction: "out" },
    { files: ["../secret"] }, { files: ["/absolute"] }, { files: ["C:\\absolute"] },
    { ids: Array(33).fill(capabilityId) }, { query: "🙂".repeat(1025) }, { query: "x", maxResponseBytes: 1 },
  ])("returns a bounded actionable error for invalid input %j", async (input) => {
    const { tool } = fixture();
    const result = await tool.handler(input);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).status).toBe("invalid_request");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2048);
  });

  it("opens model IDs beyond the input limit through snapshot-bound references", async () => {
    const { query, model, tool } = fixture();
    const id = "capability." + "x".repeat(600);
    model.objectsById.set(id, { ...model.capabilities[0]!, id, name: "uniqueneedle", summary: "uniqueneedle" });
    const found = await query({ query: "uniqueneedle" });
    const ref = found.matches[0].ref as string;
    expect(ref.length).toBeLessThan(512);
    expect(tool.inputSchema.safeParse({ ids: [ref] }).success).toBe(true);
    const opened = await query({ ids: [ref], facets: ["constraints"] });
    expect(opened.matches[0]).toMatchObject({ id, status: "ok", facets: { constraints: { status: "ok" } } });
    const expanded = await query({ operation: "expand", ids: [ref], relationships: ["entry_point"] });
    expect(expanded.matches.length).toBeGreaterThan(0);
    model.manifest.changed = true;
    expect((await query({ ids: [ref] })).matches[0].status).toBe("missing");
  });

  it("advertises the new fields in the registered MCP schema", () => {
    const { tool } = fixture();
    expect(tool.inputSchema.safeParse({ operation: "read", ids: [capabilityId], facets: ["files"], cursor: "cursor" }).success).toBe(true);
    expect(tool.description).toContain("code-point offset");
  });
});
