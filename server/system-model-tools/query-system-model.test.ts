import Database from "better-sqlite3";
import path from "path";
import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { createQuerySystemModelToolDef } from "./query-system-model.ts";
import { copyValidFixture, copyValidFixtureWithSurfaces } from "../system-model/load.test.ts";
import type { LoadedSystemModel } from "../system-model/types.ts";

describe("query_system_model", () => {
  it("rejects an empty query when ids are not provided", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    const result = await makeTool(project, model!).handler({ query: "  " });
    const payload = JSON.parse(result.content[0]!.text) as { error: string; usage: string };

    expect(result.isError).toBe(true);
    expect(payload.error).toContain("non-empty query");
    expect(payload.usage).toContain("query_system_model");
  });

  it("returns capped topK scored matches with stub-only linked objects", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    for (let index = 0; index < 12; index += 1) {
      model!.objectsById.set(`risk.extra_${index}`, {
        id: `risk.extra_${index}`,
        type: "risk",
        domain: "domain.workspace",
        summary: `needle risk ${index}`,
        severity: "medium",
        appliesTo: { capabilities: ["capability.workspace_management"], flows: [], surfaces: [], files: [] },
      });
    }
    const result = await makeTool(project, model!).handler({ query: "needle", topK: 99 });
    const payload = JSON.parse(result.content[0]!.text) as {
      matches: Array<{ id: string; score: number; reasons: string[] }>;
      linked: Array<{ id: string; type: string; label: string; summary?: string; score?: number; reasons?: string[] }>;
    };

    expect(payload.matches).toHaveLength(10);
    expect(payload.matches[0]).toEqual(expect.objectContaining({
      id: "risk.extra_0",
      score: 1,
      reasons: ["summary matched 1 term"],
    }));
    expect(payload.linked[0]).toEqual({
      id: "capability.workspace_management",
      type: "capability",
      label: "Workspace Management",
      why: "risk (inverse)",
    });
  });

  it("renders matches through the per-object budget", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    model!.policies.contextBudgets.perObjectSummary = 2;
    const result = await makeTool(project, model!).handler({ query: "workspace", objectTypes: ["capability"] });
    const payload = JSON.parse(result.content[0]!.text) as { matches: Array<{ summary: string }> };

    expect(payload.matches[0]?.summary).toBe("Manag...");
  });

  it("keeps ids lookups exact and unscored", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    const result = await makeTool(project, model!).handler({ query: "", ids: ["decision.bus_architecture"] });
    const payload = JSON.parse(result.content[0]!.text) as {
      matches: Array<{ id: string; score?: number; reasons?: string[] }>;
      linked: Array<{ id: string }>;
      matchConfidence?: string;
    };

    expect(payload.matches).toEqual([
      expect.objectContaining({ id: "decision.bus_architecture" }),
    ]);
    expect(payload.matches[0]?.score).toBeUndefined();
    expect(payload.matches[0]?.reasons).toBeUndefined();
    expect(payload.matchConfidence).toBeUndefined();
  });

  it("records usage only for returned matches with query attribution", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    const result = await makeTool(project, model!).handler({ query: "workspace", objectTypes: ["capability"] });
    const payload = JSON.parse(result.content[0]!.text) as {
      matches: Array<{ id: string }>;
      linked: Array<{ id: string }>;
    };

    expect(payload.matches.map((item) => item.id)).toEqual(["capability.workspace_management"]);
    expect(payload.linked.map((item) => item.id)).toContain("constraint.bus_only");
    expect(payload.linked).toContainEqual(expect.objectContaining({
      id: "constraint.bus_only", why: "guards (inverse)",
    }));
    const db = new Database(path.join(project, ".minions/canvas.db"));
    const rows = db.prepare("SELECT object_id, source, session_key FROM system_model_usage").all() as Array<{
      object_id: string;
      source: string;
      session_key: string;
    }>;
    expect(rows).toEqual([
      { object_id: "capability.workspace_management", source: "query", session_key: "leader-1" },
    ]);
  });

  it("labels constraints injected by scope", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    const base = model!.constraints[0]!;
    const global = { ...base, id: "constraint.global", scope: "global" as const, guards: [], appliesTo: { capabilities: [], flows: [], surfaces: [], files: [] } };
    model!.constraints.push(global);
    model!.objectsById.set(global.id, global);

    const result = await makeTool(project, model!).handler({ ids: ["capability.workspace_management"] });
    const payload = JSON.parse(result.content[0]!.text) as { linked: Array<{ id: string; why: string }> };
    expect(payload.linked).toContainEqual({
      id: "constraint.global", type: "constraint", label: global.statement, why: "scope: global",
    });
  });

  it("includes the low-confidence fallback instruction", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    const result = await makeTool(project, model!).handler({ query: "paint canvas" });
    const payload = JSON.parse(result.content[0]!.text) as { matchConfidence: string; fallbackInstruction: string };

    expect(payload.matchConfidence).toBe("low");
    expect(payload.fallbackInstruction).toBe("inspect repo; ask only if required");
  });

  it("supports exact surface ids and entry-point linked stubs", async () => {
    const project = copyValidFixtureWithSurfaces();
    const { model } = loadSystemModel(project);
    const surfaceResult = await makeTool(project, model!).handler({
      ids: ["surface.mobile"], objectTypes: ["surface"],
    });
    const surfacePayload = JSON.parse(surfaceResult.content[0]!.text) as {
      matches: Array<{ id: string; type: string }>;
      linked: Array<{ id: string; type: string }>;
    };
    expect(surfacePayload.matches).toEqual([
      expect.objectContaining({ id: "surface.mobile", type: "surface" }),
    ]);
    expect(surfacePayload.linked).toContainEqual(
      expect.objectContaining({ id: "capability.workspace_management", type: "capability" }),
    );

    const capabilityResult = await makeTool(project, model!).handler({
      ids: ["capability.workspace_management"],
    });
    const capabilityPayload = JSON.parse(capabilityResult.content[0]!.text) as {
      linked: Array<{ id: string; type: string }>;
    };
    expect(capabilityPayload.linked).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "surface.canvas", type: "surface" }),
      expect.objectContaining({ id: "surface.mobile", type: "surface" }),
    ]));
  });
});

function makeTool(project: string, model: LoadedSystemModel) {
  return createQuerySystemModelToolDef({
    leaderSessionKey: "leader-1",
    projectPath: project,
    cwd: project,
    bus: { emit: () => {}, emitToSession: () => {}, emitToProject: () => {}, emitGlobal: () => {}, subscribe: () => () => {} },
    runtime: { mode: "advisory", manifestFound: true, model, loadErrors: [] },
  });
}
