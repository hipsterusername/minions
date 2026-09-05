import fs from "node:fs";
import path from "node:path";
import type { TaskToolContext, TaskRecord } from "./types.ts";
import { readSettings } from "../project-store.ts";
import { getWorkPacket } from "../system-model/store.ts";
import { computePacketApplicability, gatedSurfaceGlobs } from "../system-model/applicability.ts";
import { loadSystemModel } from "../system-model/load.ts";
const pending = new WeakMap<object, Map<string, string[]>>();

export function reserveAssignment(ctx: TaskToolContext, task: TaskRecord): () => void {
  const scopes = pending.get(ctx.taskState) ?? new Map<string, string[]>();
  pending.set(ctx.taskState, scopes);
  scopes.set(task.taskId, (task.ownedPaths ?? []).map(scope => ownershipRoot(ctx.cwd, scope)));
  return () => { scopes.delete(task.taskId); };
}

/** Conservative directory/glob exclusion, resolving symlink aliases and future paths. */
export function ownershipRoot(cwd: string, scope: string): string {
  const wildcard = scope.search(/[*?{[!]/);
  const literal = wildcard < 0 ? scope : scope.slice(0, wildcard);
  let target = path.resolve(cwd, wildcard < 0 || literal.endsWith("/") ? literal : path.dirname(literal));
  const tail: string[] = [];
  while (!fs.existsSync(target)) {
    const parent = path.dirname(target);
    if (parent === target) break;
    tail.unshift(path.basename(target)); target = parent;
  }
  return path.join(fs.realpathSync(target), ...tail);
}

export function checkAssignmentAdmission(ctx: TaskToolContext, task: Pick<TaskRecord, "taskId" | "ownedPaths" | "files">,
  packetId?: string): void {
  const roots = (task.ownedPaths ?? []).map(scope => ownershipRoot(ctx.cwd, scope));
  for (const [taskId, reserved] of pending.get(ctx.taskState) ?? []) {
    if (taskId === task.taskId || roots.some(root => reserved.some(other => root === other
      || root.startsWith(other + path.sep) || other.startsWith(root + path.sep)))) {
      throw new Error(`Write ownership overlaps active task ${taskId}; allocation is pending.`);
    }
  }
  for (const other of ctx.taskState.tasks.values()) {
    if (other.taskId === task.taskId || !["starting", "running", "blocked"].includes(other.status)) continue;
    const conflicting = (other.ownedPaths ?? []).some(scope => {
      const root = ownershipRoot(ctx.cwd, scope);
      return roots.some(owned => owned === root || owned.startsWith(root + path.sep) || root.startsWith(owned + path.sep));
    });
    if (conflicting) throw new Error(`Write ownership overlaps active task ${other.taskId}; wait for it to finish or narrow the declared scope.`);
  }
  const settings = readSettings(ctx.projectPath);
  if (settings.systemModel === "off") return;
  const model = ctx.systemModel ?? loadSystemModel(ctx.cwd).model;
  if (settings.systemModel === "enforced" && !model) throw new Error("Enforced system model is unavailable; assignment is blocked.");
  const scoped = [...(task.files ?? []), ...(task.ownedPaths ?? [])];
  const required = settings.systemModel === "enforced" && model
    && (computePacketApplicability(model, scoped).packetRequired || scoped.some(scope => {
      const root = ownershipRoot(ctx.cwd, scope);
      return gatedSurfaceGlobs(model).some(glob => {
        const gateRoot = ownershipRoot(ctx.cwd, glob);
        return root === gateRoot || gateRoot.startsWith(root + path.sep) || root.startsWith(gateRoot + path.sep);
      });
    }));
  if (required && !packetId) throw new Error("A valid Work Packet is required before assigning this gated task.");
  if (!packetId) return;
  const packet = getWorkPacket(ctx.projectPath, packetId)?.packet;
  if (!packet || packet.leaderSessionKey !== ctx.leaderSessionKey) throw new Error("Work Packet is missing or belongs to another session.");
  if (required && packet.freshness.status === "stale_blocked") throw new Error("Work Packet requires freshness verification before assignment.");
}
