import path from "path";
import { exec } from "../worktree-exec.ts";
import type { FreshnessTimestampFn } from "../system-model/freshness.ts";
import type { SystemModelRuntime } from "../system-model/runtime.ts";
import type { Bus } from "../bus.ts";
import type { DetailedDiff } from "../worktree-types.ts";

export interface SystemModelToolContext {
  leaderSessionKey: string;
  projectPath: string;
  cwd: string;
  runtime: SystemModelRuntime;
  bus: Bus;
  now?: () => number;
  getHeadSha?: () => Promise<string>;
  timestampFn?: FreshnessTimestampFn;
  /** Actual worktree or repository diff used by terminal reconciliation. */
  getDetailedDiff?: () => Promise<DetailedDiff>;
}

export function modeForCompile(runtime: SystemModelRuntime): "advisory" | "enforced" {
  return runtime.mode === "enforced" ? "enforced" : "advisory";
}

export function normalizeGoal(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function createPacketId(now: number, text: string): string {
  const slug = normalizeGoal(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "work";
  return `wp_${now.toString(36)}_${slug}`;
}

export async function getHeadSha(ctx: Pick<SystemModelToolContext, "cwd" | "getHeadSha">): Promise<string> {
  if (ctx.getHeadSha) return ctx.getHeadSha();
  try {
    return (await exec(["rev-parse", "HEAD"], ctx.cwd)).stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export const gitTimestampFn: FreshnessTimestampFn = async ({ cwd, objectFile, globs }) => {
  const modelTouchedAt = await lastTouched(cwd, objectFile);
  const codeTimes = await Promise.all(globs.map((glob) => lastTouched(cwd, glob)));
  const knownCodeTimes = codeTimes.filter((time): time is number => time !== null);
  return {
    modelTouchedAt,
    codeTouchedAt: knownCodeTimes.length > 0 ? Math.max(...knownCodeTimes) : null,
  };
};

async function lastTouched(cwd: string, fileOrGlob: string): Promise<number | null> {
  try {
    const rel = fileOrGlob.startsWith(".systemmodel/")
      ? fileOrGlob
      : path.normalize(fileOrGlob).replaceAll(path.sep, "/");
    const { stdout } = await exec(["log", "-1", "--format=%ct", "--", rel], cwd);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
