import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import type { SystemModelObject, SystemModelObjectType } from "../../shared/system-model/index.ts";
import type { SystemModelRuntime } from "../system-model/runtime.ts";
import { recordSystemModelUsage } from "../system-model/store.ts";

export interface SystemModelToolContext {
  leaderSessionKey: string;
  projectPath: string;
  runtime: SystemModelRuntime;
}

const querySystemModelInputSchema = z.object({
  query: z.string(),
  objectTypes: z.array(z.enum([
    "capability",
    "flow",
    "constraint",
    "decision",
    "risk",
  ])).optional(),
  ids: z.array(z.string()).optional(),
});

export function createQuerySystemModelToolDef(ctx: SystemModelToolContext): NormalizedToolDef {
  return {
    name: "query_system_model",
    description:
      "Read matching system-model objects by free-text query, object type, or id. Results include directly linked objects.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    inputSchema: querySystemModelInputSchema,
    handler: async (input: unknown) => {
      const args = querySystemModelInputSchema.parse(input);
      const model = ctx.runtime.model;
      if (!model) return jsonResult({ matches: [], linked: [], loadErrors: ctx.runtime.loadErrors });
      const typeFilter = new Set<SystemModelObjectType>(args.objectTypes ?? []);
      const idFilter = new Set(args.ids ?? []);
      const all = [...model.objectsById.values()];
      const matches = all.filter((object) =>
        (typeFilter.size === 0 || typeFilter.has(object.type)) &&
        (idFilter.size === 0 || idFilter.has(object.id)) &&
        (idFilter.size > 0 || matchesQuery(object, args.query)),
      );
      const linked = expandLinked(matches, model.objectsById);
      recordSystemModelUsage(ctx.projectPath, [...matches, ...linked].map((object) => ({
        objectId: object.id,
        workPacketId: ctx.leaderSessionKey,
        usedAt: Date.now(),
      })));
      return jsonResult({ matches, linked });
    },
  };
}

function matchesQuery(object: SystemModelObject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return searchableText(object).includes(q);
}

function searchableText(object: SystemModelObject): string {
  return JSON.stringify(object).toLowerCase();
}

function expandLinked(
  matches: SystemModelObject[],
  objectsById: Map<string, SystemModelObject>,
): SystemModelObject[] {
  const matchIds = new Set(matches.map((object) => object.id));
  const linked = new Map<string, SystemModelObject>();
  for (const object of matches) {
    for (const id of linkedIds(object)) {
      if (matchIds.has(id)) continue;
      const linkedObject = objectsById.get(id);
      if (linkedObject) linked.set(id, linkedObject);
    }
  }
  return [...linked.values()];
}

function linkedIds(object: SystemModelObject): string[] {
  if (object.type === "capability") {
    return [...object.linkedFlows, ...object.constraints, ...object.decisions, ...object.risks];
  }
  if (object.type === "flow") {
    return [...object.capabilities, ...object.constraints, ...object.decisions, ...object.risks];
  }
  if (object.type === "constraint") {
    return [
      ...object.appliesTo.capabilities,
      ...object.appliesTo.flows,
      ...object.evidence,
    ];
  }
  if (object.type === "risk") {
    return [...object.appliesTo.capabilities, ...object.appliesTo.flows];
  }
  return [];
}
