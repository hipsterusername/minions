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
    `SELECT id, created_at FROM work_packets
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ?`,
  ).all(limit) as Array<{ id: string; created_at: number }>;
  const recentPacketIds = packetRows.map((row) => row.id);
  if (recentPacketIds.length === 0) {
    const queryRows = db.prepare(
      `SELECT DISTINCT object_id FROM system_model_usage
       WHERE source = 'query'`,
    ).all() as Array<{ object_id: string }>;
    const queried = new Set(queryRows.map((row) => row.object_id));
    return sortedObjects(input.model)
      .filter((object) => !queried.has(object.id))
      .map((object) => describeObject(object, "No Work Packets and no query usage recorded"));
  }

  const oldestCreatedAt = Math.min(...packetRows.map((row) => row.created_at));
  const placeholders = recentPacketIds.map(() => "?").join(", ");
  const packetUsageRows = db.prepare(
    `SELECT DISTINCT object_id FROM system_model_usage
     WHERE source = 'packet' AND work_packet_id IN (${placeholders})`,
  ).all(...recentPacketIds) as Array<{ object_id: string }>;
  const queryUsageRows = db.prepare(
    `SELECT DISTINCT object_id FROM system_model_usage
     WHERE source = 'query' AND used_at >= ?`,
  ).all(oldestCreatedAt) as Array<{ object_id: string }>;
  const used = new Set([
    ...packetUsageRows.map((row) => row.object_id),
    ...queryUsageRows.map((row) => row.object_id),
  ]);
  return sortedObjects(input.model)
    .filter((object) => !used.has(object.id))
    .map((object) =>
      describeObject(
        object,
        `No packet usage in last ${recentPacketIds.length} Work Packets and no query usage since ${oldestCreatedAt}`,
      ),
    );
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
    .filter((object) => object.type !== "domain")
    .filter((object) => object.type !== "constraint" || (object.scope === "targeted" && object.guards.length === 0))
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
  if (object.type === "domain" || object.type === "capability" || object.type === "flow" || object.type === "surface") return object.name;
  if (object.type === "constraint") return object.statement;
  if (object.type === "decision") return object.title;
  return object.summary;
}

function objectFileFor(object: Extract<SystemModelObject, { type: "capability" | "flow" }>): string {
  return `.systemmodel/${object.type === "capability" ? "capabilities" : "flows"}/${object.id.split(".")[1]}.yaml`;
}
