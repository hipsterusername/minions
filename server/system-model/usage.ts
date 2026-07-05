import type { SystemModelObject } from "../../shared/system-model/index.ts";
import { checkFreshness, type FreshnessTimestampFn } from "./freshness.ts";
import { systemModelToGraph } from "./graph.ts";
import type { LoadedSystemModel } from "./types.ts";
import { openProjectDb } from "../project-store.ts";

export interface UsageObject {
  id: string;
  type: SystemModelObject["type"];
  label: string;
  reason: string;
}

export interface StaleObject extends UsageObject {
  status: "stale";
  modelTouchedAt: number | null;
  codeTouchedAt: number | null;
}

export async function unusedInLastNPackets(input: {
  projectPath: string;
  model: LoadedSystemModel;
  n?: number;
}): Promise<UsageObject[]> {
  const limit = Math.max(1, input.n ?? 30);
  const db = openProjectDb(input.projectPath);
  const packetRows = db.prepare(
    `SELECT id FROM work_packets
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ?`,
  ).all(limit) as Array<{ id: string }>;
  const recentPacketIds = packetRows.map((row) => row.id);
  if (recentPacketIds.length === 0) {
    return sortedObjects(input.model).map((object) => describeObject(object, "No recent Work Packets"));
  }

  const placeholders = recentPacketIds.map(() => "?").join(", ");
  const usedRows = db.prepare(
    `SELECT DISTINCT object_id FROM system_model_usage
     WHERE work_packet_id IN (${placeholders})`,
  ).all(...recentPacketIds) as Array<{ object_id: string }>;
  const used = new Set(usedRows.map((row) => row.object_id));
  return sortedObjects(input.model)
    .filter((object) => !used.has(object.id))
    .map((object) => describeObject(object, `Unused in last ${recentPacketIds.length} Work Packets`));
}

export async function staleObjects(input: {
  model: LoadedSystemModel;
  cwd: string;
  headSha: string;
  mode: "advisory" | "enforced";
  timestampFn: FreshnessTimestampFn;
}): Promise<StaleObject[]> {
  const objects = sortedObjects(input.model).filter(
    (object): object is Extract<SystemModelObject, { type: "capability" | "flow" }> =>
      object.type === "capability" || object.type === "flow",
  );
  const report = await checkFreshness({
    cwd: input.cwd,
    headSha: input.headSha,
    mode: input.mode,
    subjects: objects.map((object) => ({
      objectId: object.id,
      objectFile: objectFileFor(object),
      globs: object.suggestedFiles,
      freshnessClass: object.freshness?.class,
      policyClass: "ordinary",
    })),
    policies: input.model.policies.freshness,
    getTimestamps: input.timestampFn,
  });
  return report.objects
    .filter((object) => object.status === "stale")
    .map((object) => {
      const source = input.model.objectsById.get(object.objectId)!;
      return {
        ...describeObject(source, "Model file is older than matching code"),
        status: "stale" as const,
        modelTouchedAt: object.modelTouchedAt,
        codeTouchedAt: object.codeTouchedAt,
      };
    });
}

export function orphanedObjects(model: LoadedSystemModel): UsageObject[] {
  const graph = systemModelToGraph(model);
  const inbound = new Set(graph.edges.map((edge) => edge.target));
  return sortedObjects(model)
    .filter((object) => !inbound.has(object.id))
    .map((object) => describeObject(object, "No inbound links in the system graph"));
}

function sortedObjects(model: LoadedSystemModel): SystemModelObject[] {
  return [...model.objectsById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function describeObject(object: SystemModelObject, reason: string): UsageObject {
  return {
    id: object.id,
    type: object.type,
    label: labelFor(object),
    reason,
  };
}

function labelFor(object: SystemModelObject): string {
  if (object.type === "capability" || object.type === "flow") return object.name;
  if (object.type === "constraint") return object.statement;
  if (object.type === "decision") return object.title;
  return object.summary;
}

function objectFileFor(object: Extract<SystemModelObject, { type: "capability" | "flow" }>): string {
  return `.systemmodel/${object.type === "capability" ? "capabilities" : "flows"}/${object.id.split(".")[1]}.yaml`;
}
