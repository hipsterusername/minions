import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ExperimentPlanSchema, TaskDefinitionSchema, type ExperimentCell, type ExperimentPlan, type TaskDefinition } from "../../schemas/index.js";
import { assertParticipantSafePath } from "./utils.js";

export interface TaskAssetRoots { readonly taskRoot: string; readonly publicRoot: string; readonly graderRoot?: string; }

/** Validates a task and proves all participant-visible references remain in its public package. */
export async function validateTaskManifest(input: unknown, roots: TaskAssetRoots): Promise<TaskDefinition> {
  const task = TaskDefinitionSchema.parse(input);
  const root = await realpath(roots.taskRoot);
  const publicRoot = await realpath(roots.publicRoot);
  if (!isWithin(root, publicRoot)) throw new Error("public fixture root must be inside task root");
  for (const path of [task.promptFile, task.fixture.configFile]) {
    assertParticipantSafePath(path);
    const resolved = resolve(root, path);
    if (!isWithin(root, resolved)) throw new Error(`task asset escapes task root: ${path}`);
    const info = await lstat(resolved);
    if (!isWithin(publicRoot, await realpath(resolved))) throw new Error(`task asset symlink escapes allowed root: ${path}`);
  }
  // Grader configuration is controller-side and may intentionally live in a
  // sibling ground-truth package.  It is still traversal-checked against the
  // explicit controller root rather than being copied into participant input.
  if (roots.graderRoot) {
    const graderRoot = await realpath(roots.graderRoot);
    const graderPath = resolve(root, task.grader.configFile);
    if (!isWithin(graderRoot, graderPath)) throw new Error(`grader asset escapes grader root: ${task.grader.configFile}`);
    const info = await lstat(graderPath);
    if (!isWithin(graderRoot, await realpath(graderPath))) throw new Error(`grader asset symlink escapes grader root: ${task.grader.configFile}`);
  }
  for (const path of [...task.submission.include, ...task.submission.exclude]) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`unsafe submission pattern: ${path}`);
  }
  return task;
}

export function createImmutablePlan(input: unknown, tasks: readonly TaskDefinition[], fixtureSeeds: Readonly<Record<string, string>>): ExperimentPlan {
  const plan = ExperimentPlanSchema.parse(input);
  if (new Set(tasks.map(t => t.id)).size !== tasks.length || new Set(plan.adapterConfigs.map(a => a.adapterId)).size !== plan.adapterConfigs.length) throw new Error("duplicate task or adapter identity");
  if (!tasks.length || !plan.adapterConfigs.length || Object.keys(plan.taskRevisions).length !== tasks.length) throw new Error("plan task cohort mismatch");
  for (const task of tasks) {
    if (plan.taskRevisions[task.id] !== task.revision) throw new Error(`plan revision does not match task ${task.id}`);
    if (!fixtureSeeds[task.id]) throw new Error(`missing fixture seed for task ${task.id}`);
  }
  // Schema types are mutable for parsing ergonomics; freeze at the runtime boundary.
  return deepFreeze(plan);
}

/** A repeatable Fisher-Yates expansion; schedule order is locked before execution. */
export function scheduleCells(plan: ExperimentPlan, tasks: readonly TaskDefinition[], fixtureSeeds: Readonly<Record<string, string>>): readonly ExperimentCell[] {
  const cells: ExperimentCell[] = [];
  for (const task of tasks) for (const adapter of plan.adapterConfigs) for (let repetition = 0; repetition < plan.repetitions; repetition += 1) {
    cells.push({ schemaVersion: 1, cellId: `${task.id}:${adapter.adapterId}:${repetition}`, experimentId: plan.experimentId, taskId: task.id, adapterId: adapter.adapterId, repetition, fixtureSeed: createHash("sha256").update(fixtureSeeds[task.id]! + ":" + repetition).digest("hex"), status: "planned" });
  }
  const random = seededRandom(plan.schedulingSeed);
  for (let i = cells.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [cells[i], cells[j]] = [cells[j]!, cells[i]!]; }
  return Object.freeze(cells.map((cell) => Object.freeze(cell)));
}

function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}
function isWithin(root: string, target: string): boolean { const path = relative(root, target); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)); }

function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
