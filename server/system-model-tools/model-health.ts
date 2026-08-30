import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import {
  orphanedObjects,
  staleObjects,
  unusedInLastNPackets,
  type UsageObject,
} from "../system-model/usage.ts";
import type { LoadedSystemModel } from "../system-model/types.ts";
import * as validationModule from "../system-model/validate.ts";
import { exec } from "../worktree-exec.ts";
import {
  getHeadSha,
  gitTimestampFn,
  modeForCompile,
  type SystemModelToolContext,
} from "./shared.ts";

const modelHealthInputSchema = z.object({
  unusedPacketWindow: z.number().int().positive().max(500).default(30),
});

interface PruneRecommendation {
  id: string;
  type: UsageObject["type"];
  label: string;
  reasons: string[];
  recommendation: "prune_or_update" | "prune_or_link" | "review_for_prune";
}

interface EvidenceGap {
  id: string;
  type: UsageObject["type"] | "decision";
  label: string;
  missing: Array<"suggested_files" | "suggested_tests" | "evidence">;
  recommendation: string;
}

type ComputeOverbreadthFn = (model: LoadedSystemModel, trackedFiles: string[]) => unknown[];

interface ModelHealthToolContext extends SystemModelToolContext {
  trackedFiles?: () => Promise<string[]>;
  computeOverbreadth?: ComputeOverbreadthFn;
  overbreadthThreshold?: number;
}

export function createModelHealthToolDef(ctx: ModelHealthToolContext): NormalizedToolDef {
  return {
    name: "model_health",
    description:
      "Report unused, stale, orphaned, overbroad, and under-evidenced system-model objects with actionable recommendations.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: modelHealthInputSchema,
    handler: async (input: unknown) => {
      const args = modelHealthInputSchema.parse(input);
      const model = ctx.runtime.model;
      if (!model) {
        return jsonResult({
          counts: emptyCounts(),
          unused: [],
          stale: [],
          orphaned: [],
          overbroad: [],
          evidenceGaps: [],
          pruneRecommendations: [],
          loadErrors: ctx.runtime.loadErrors,
        });
      }
      const [unused, stale, orphaned, overbroad] = await Promise.all([
        unusedInLastNPackets({
          projectPath: ctx.projectPath,
          model,
          n: args.unusedPacketWindow,
        }),
        staleObjects({
          model,
          cwd: ctx.cwd,
          headSha: await getHeadSha(ctx),
          mode: modeForCompile(ctx.runtime),
          timestampFn: ctx.timestampFn ?? gitTimestampFn,
        }),
        Promise.resolve(orphanedObjects(model)),
        overbroadApplicability(ctx, model),
      ]);
      return jsonResult({
        counts: modelCounts(model),
        unused,
        stale,
        orphaned,
        overbroad,
        evidenceGaps: evidenceGaps(model),
        pruneRecommendations: recommendations(unused, stale, orphaned),
      });
    },
  };
}

function evidenceGaps(model: LoadedSystemModel): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  for (const object of [...model.capabilities, ...model.flows]) {
    const missing: EvidenceGap["missing"] = [];
    if (object.suggestedFiles.length === 0) missing.push("suggested_files");
    if (object.suggestedTests.length === 0) missing.push("suggested_tests");
    if (missing.length > 0) gaps.push({
      id: object.id,
      type: object.type,
      label: object.name,
      missing,
      recommendation: "Add current implementation and verification anchors, or prune the object if it no longer guides work.",
    });
  }
  for (const constraint of model.constraints) {
    const missing: EvidenceGap["missing"] = [];
    if (constraint.suggestedTests.length === 0) missing.push("suggested_tests");
    if (constraint.evidence.length === 0) missing.push("evidence");
    if (missing.length > 0) gaps.push({
      id: constraint.id,
      type: "constraint",
      label: constraint.statement,
      missing,
      recommendation: "Anchor the invariant to a decision and an executable or reviewable verification target.",
    });
  }
  for (const decision of model.decisions.filter((item) => item.status === "accepted")) {
    if (decision.evidence.length > 0) continue;
    gaps.push({
      id: decision.id,
      type: "decision",
      label: decision.title,
      missing: ["evidence"],
      recommendation: "Add current code or test evidence that demonstrates the accepted decision remains implemented.",
    });
  }
  return gaps.sort((a, b) => a.id.localeCompare(b.id));
}

function modelCounts(model: LoadedSystemModel) {
  return {
    domains: model.domains.length,
    capabilities: model.capabilities.length,
    flows: model.flows.length,
    constraints: model.constraints.length,
    decisions: model.decisions.length,
    risks: model.risks.length,
    surfaces: model.surfaces.length,
  };
}

function emptyCounts(): ReturnType<typeof modelCounts> {
  return {
    domains: 0,
    capabilities: 0,
    flows: 0,
    constraints: 0,
    decisions: 0,
    risks: 0,
    surfaces: 0,
  };
}

interface OverbroadApplicability {
  id: string;
  type: string;
  label: string;
  coveragePercent: number;
  thresholdPercent: number;
  matchedFiles?: number;
  totalFiles?: number;
  globs: string[];
}

async function overbroadApplicability(
  ctx: ModelHealthToolContext,
  model: LoadedSystemModel,
): Promise<OverbroadApplicability[]> {
  const compute = ctx.computeOverbreadth ?? exportedComputeOverbreadth();
  if (!compute) return [];
  const trackedFiles = await getTrackedFiles(ctx);
  const threshold = ctx.overbreadthThreshold ?? exportedOverbreadthThreshold();
  return compute(model, trackedFiles).map((item) => normalizeOverbroadItem(item, threshold, model));
}

async function getTrackedFiles(ctx: ModelHealthToolContext): Promise<string[]> {
  if (ctx.trackedFiles) return ctx.trackedFiles();
  try {
    const { stdout } = await exec(["ls-files"], ctx.cwd);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function exportedComputeOverbreadth(): ComputeOverbreadthFn | undefined {
  const exports = validationModule as unknown as { computeOverbreadth?: ComputeOverbreadthFn };
  return exports.computeOverbreadth;
}

function exportedOverbreadthThreshold(): number {
  const exports = validationModule as unknown as { OVERBREADTH_THRESHOLD?: number };
  return exports.OVERBREADTH_THRESHOLD ?? 0.4;
}

function normalizeOverbroadItem(
  item: unknown,
  threshold: number,
  model: LoadedSystemModel,
): OverbroadApplicability {
  const record = item as Record<string, unknown>;
  const id = stringField(record, "id", "objectId", "gateId");
  const type = stringField(record, "type", "kind");
  const coverage = numberField(record, "coverage", "ratio", "coverageRatio");
  const percent = coverage > 1 ? coverage : coverage * 100;
  const globs = arrayField(record, "globs", "files", "patterns");
  return {
    id,
    type,
    label: stringField(record, "label", "name", "statement") || labelForOverbroad(id, model),
    coveragePercent: Math.round(percent * 10) / 10,
    thresholdPercent: Math.round(threshold * 1000) / 10,
    matchedFiles: optionalNumberField(record, "matchedFiles", "matchedFileCount"),
    totalFiles: optionalNumberField(record, "totalFiles", "trackedFiles", "sourceFiles"),
    globs: globs.length > 0 ? globs : globsForOverbroad(id, type, model),
  };
}

function labelForOverbroad(id: string, model: LoadedSystemModel): string {
  const object = model.objectsById.get(id);
  if (object?.type === "constraint") return object.statement;
  const gate = model.reviewGatesById.get(id);
  return gate?.name ?? id;
}

function globsForOverbroad(id: string, type: string, model: LoadedSystemModel): string[] {
  if (type === "gate") return model.reviewGatesById.get(id)?.requiredWhen.files ?? [];
  const object = model.objectsById.get(id);
  return object?.type === "constraint" ? object.appliesTo.files : [];
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number {
  return optionalNumberField(record, ...keys) ?? 0;
}

function optionalNumberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function arrayField(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function recommendations(
  unused: UsageObject[],
  stale: UsageObject[],
  orphaned: UsageObject[],
): PruneRecommendation[] {
  const reasons = new Map<string, string[]>();
  const byId = new Map<string, UsageObject>();
  for (const item of [...unused, ...stale, ...orphaned]) {
    byId.set(item.id, item);
    reasons.set(item.id, [...(reasons.get(item.id) ?? []), item.reason]);
  }
  return [...reasons.entries()].map(([id, itemReasons]) => {
    const item = byId.get(id)!;
    return {
      id,
      type: item.type,
      label: item.label,
      reasons: itemReasons,
      recommendation: recommendationFor(itemReasons),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function recommendationFor(reasons: string[]): PruneRecommendation["recommendation"] {
  const hasStale = reasons.some((reason) => reason.includes("older than matching code"));
  const hasOrphan = reasons.some((reason) => reason.includes("No inbound links"));
  if (hasStale) return "prune_or_update";
  if (hasOrphan) return "prune_or_link";
  return "review_for_prune";
}
