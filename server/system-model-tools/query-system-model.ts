import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import type { SystemModelObject, SystemModelObjectType } from "../../shared/system-model/index.ts";
import { recordSystemModelUsage } from "../system-model/store.ts";
import { matchSystemModel } from "../system-model/match.ts";
import type { SystemModelToolContext } from "./shared.ts";

const querySystemModelInputSchema = z.object({
  query: z.string().optional(),
  objectTypes: z.array(z.enum([
    "capability",
    "flow",
    "constraint",
    "decision",
    "risk",
  ])).optional(),
  ids: z.array(z.string()).optional(),
  topK: z.number().int().positive().optional(),
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
      const query = args.query?.trim() ?? "";
      if (idFilter.size === 0 && query.length === 0) {
        return jsonResult({
          error: "Pass a non-empty query, exact ids, or objectTypes with a query.",
          usage: "query_system_model({ query, objectTypes?, ids?, topK? })",
          matches: [],
          linked: [],
        }, { isError: true });
      }
      const topK = Math.min(args.topK ?? 5, 10);
      const matchResult = idFilter.size > 0
        ? undefined
        : matchSystemModel({
          model: withTypeFilter(model, typeFilter),
          request: query,
          topK,
        });
      const matches = idFilter.size > 0
        ? (args.ids ?? [])
          .flatMap((id) => {
            const object = model.objectsById.get(id);
            return object && (typeFilter.size === 0 || typeFilter.has(object.type)) ? [object] : [];
          })
          .map((object) => renderMatch(object, model.policies.contextBudgets.perObjectSummary))
        : (matchResult?.candidates ?? []).map((candidate) => {
          const object = model.objectsById.get(candidate.id)!;
          return {
            ...renderMatch(object, model.policies.contextBudgets.perObjectSummary),
            score: candidate.score,
            reasons: candidate.reasons,
          };
        });
      const matchedObjects = matches.flatMap((match) => {
        const object = model.objectsById.get(match.id);
        return object ? [object] : [];
      });
      const linked = expandLinked(matches, model.objectsById);
      recordSystemModelUsage(ctx.projectPath, matchedObjects.map((object) => ({
        objectId: object.id,
        source: "query",
        sessionKey: ctx.leaderSessionKey,
        usedAt: Date.now(),
      })));
      return jsonResult({
        matches,
        linked,
        ...(matchResult ? {
          matchConfidence: matchResult.matchConfidence,
          ...(matchResult.fallbackInstruction ? { fallbackInstruction: matchResult.fallbackInstruction } : {}),
        } : {}),
      });
    },
  };
}

function withTypeFilter(model: SystemModelToolContext["runtime"]["model"], typeFilter: Set<SystemModelObjectType>) {
  if (!model || typeFilter.size === 0) return model!;
  const objectsById = new Map([...model.objectsById].filter(([, object]) => typeFilter.has(object.type)));
  return { ...model, objectsById };
}

function expandLinked(
  matches: Array<{ id: string }>,
  objectsById: Map<string, SystemModelObject>,
): Array<{ id: string; type: SystemModelObjectType; label: string }> {
  const matchIds = new Set(matches.map((object) => object.id));
  const linked = new Map<string, { id: string; type: SystemModelObjectType; label: string }>();
  for (const match of matches) {
    const object = objectsById.get(match.id);
    if (!object) continue;
    for (const id of linkedIds(object)) {
      if (matchIds.has(id)) continue;
      const linkedObject = objectsById.get(id);
      if (linkedObject) linked.set(id, { id: linkedObject.id, type: linkedObject.type, label: labelFor(linkedObject) });
    }
  }
  return [...linked.values()];
}

function renderMatch(object: SystemModelObject, tokens: number) {
  return {
    id: object.id,
    type: object.type,
    label: labelFor(object),
    summary: trimToTokens(summaryFor(object), tokens),
  };
}

function labelFor(object: SystemModelObject): string {
  if (object.type === "capability" || object.type === "flow") return object.name;
  if (object.type === "constraint") return object.statement;
  if (object.type === "decision") return object.title;
  return object.summary;
}

function summaryFor(object: SystemModelObject): string {
  if (object.type === "capability" || object.type === "flow") return object.summary;
  if (object.type === "constraint") return object.agentInstruction ?? object.statement;
  if (object.type === "decision") return object.summary;
  return object.summary;
}

function trimToTokens(text: string, tokens: number): string {
  const maxChars = tokens * 4;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
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
