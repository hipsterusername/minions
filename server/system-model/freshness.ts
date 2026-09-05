import type { RequiredVerification } from "../../shared/system-model/index.ts";
import type { LoadedSystemModel } from "./types.ts";

export type FreshnessMode = "advisory" | "enforced";
export type FreshnessStatus = "fresh" | "partially_stale" | "stale_blocked" | "unknown";

export interface FreshnessSubject {
  objectId: string;
  objectFile: string;
  globs: string[];
  freshnessClass?: "code_coupled" | "policy" | "informational";
  policyClass?: string;
}

export interface FreshnessTimestamps {
  modelTouchedAt: number | null;
  codeTouchedAt: number | null;
}

export type FreshnessTimestampFn = (query: {
  cwd: string;
  headSha: string;
  objectFile: string;
  globs: string[];
}) => Promise<FreshnessTimestamps>;

export interface FreshnessObjectResult extends FreshnessSubject {
  status: "fresh" | "stale" | "unknown" | "not_code_coupled";
  consequence?: "verify_before_task" | "required_agent_actions" | "block_if_unverified";
  requiredActions: string[];
  modelTouchedAt: number | null;
  codeTouchedAt: number | null;
  warning?: string;
}

export interface FreshnessReport {
  status: FreshnessStatus;
  warnings: string[];
  requiredVerifications: RequiredVerification[];
  requiredAgentActions: string[];
  objects: FreshnessObjectResult[];
}

const timestampCache = new Map<string, Map<string, Promise<FreshnessTimestamps>>>();

export function clearFreshnessCache(): void {
  timestampCache.clear();
}

export async function checkFreshness(input: {
  cwd: string;
  headSha: string;
  mode: FreshnessMode;
  subjects: FreshnessSubject[];
  policies: LoadedSystemModel["policies"]["freshness"];
  getTimestamps: FreshnessTimestampFn;
  verifiedTargets?: string[];
}): Promise<FreshnessReport> {
  const verified = new Set(input.verifiedTargets ?? []);
  const objects = await Promise.all(input.subjects.map((subject) => checkSubject(input, subject, verified)));
  const warnings = objects.flatMap((object) => object.warning ? [object.warning] : []);
  const requiredAgentActions = unique(objects.flatMap((object) => object.requiredActions));
  const requiredVerifications = objects
    .filter((object) => object.status === "stale" && object.consequence)
    .filter((object) => !verified.has(object.objectId))
    .map((object) => ({
      kind: "freshness" as const,
      target: object.objectId,
      reason: freshnessReason(object),
      status: "not_run" as const,
    }));

  return {
    status: aggregateStatus(input.mode, objects, requiredVerifications),
    warnings,
    requiredVerifications,
    requiredAgentActions,
    objects,
  };
}

async function checkSubject(
  input: Parameters<typeof checkFreshness>[0],
  subject: FreshnessSubject,
  verified: Set<string>,
): Promise<FreshnessObjectResult> {
  const policy = input.policies.find((item) => item.policyClass === (subject.policyClass ?? subject.freshnessClass ?? "code_coupled"));
  if (subject.freshnessClass && subject.freshnessClass !== "code_coupled") {
    // Policy and informational guidance require semantic review, not code timestamp inference.
    return { ...baseResult(subject, "not_code_coupled", null, null),
      consequence: policy?.consequence, requiredActions: policy?.requiredActions ?? [] };
  }
  const timestamps = await cachedTimestamps(input, subject);
  if (timestamps.modelTouchedAt === null || timestamps.codeTouchedAt === null) {
    return {
      ...baseResult(subject, "unknown", timestamps.modelTouchedAt, timestamps.codeTouchedAt),
      warning: `Freshness unknown for ${subject.objectId}`,
    };
  }
  if (timestamps.codeTouchedAt <= timestamps.modelTouchedAt) {
    return baseResult(subject, "fresh", timestamps.modelTouchedAt, timestamps.codeTouchedAt);
  }

  const consequence = policy?.consequence ?? "verify_before_task";
  const isBlocking = consequence === "block_if_unverified" && input.mode === "enforced" && !verified.has(subject.objectId);
  return {
    ...baseResult(subject, "stale", timestamps.modelTouchedAt, timestamps.codeTouchedAt),
    consequence,
    requiredActions: policy?.requiredActions ?? [],
    warning: isBlocking
      ? `Freshness stale-blocked for ${subject.objectId}`
      : `Freshness stale for ${subject.objectId}`,
  };
}

function cachedTimestamps(
  input: Parameters<typeof checkFreshness>[0],
  subject: FreshnessSubject,
): Promise<FreshnessTimestamps> {
  const bucketKey = `${input.cwd}\0${input.headSha}`;
  const itemKey = `${subject.objectFile}\0${[...subject.globs].sort().join("\0")}`;
  let bucket = timestampCache.get(bucketKey);
  if (!bucket) {
    bucket = new Map();
    timestampCache.set(bucketKey, bucket);
  }
  let hit = bucket.get(itemKey);
  if (!hit) {
    hit = input.getTimestamps({
      cwd: input.cwd,
      headSha: input.headSha,
      objectFile: subject.objectFile,
      globs: subject.globs,
    });
    bucket.set(itemKey, hit);
  }
  return hit;
}

function aggregateStatus(
  mode: FreshnessMode,
  objects: FreshnessObjectResult[],
  requiredVerifications: RequiredVerification[],
): FreshnessStatus {
  if (objects.some((object) => object.status === "unknown")) return "unknown";
  const stale = objects.filter((object) => object.status === "stale");
  if (stale.length === 0) return "fresh";
  if (
    mode === "enforced"
    && stale.some((object) => object.consequence === "block_if_unverified")
    && requiredVerifications.some((verification) => verification.kind === "freshness")
  ) return "stale_blocked";
  return "partially_stale";
}

function baseResult(
  subject: FreshnessSubject,
  status: FreshnessObjectResult["status"],
  modelTouchedAt: number | null,
  codeTouchedAt: number | null,
): FreshnessObjectResult {
  return {
    ...subject,
    status,
    requiredActions: [],
    modelTouchedAt,
    codeTouchedAt,
  };
}

function freshnessReason(object: FreshnessObjectResult): string {
  return `${object.objectId} model file is older than matching code`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
