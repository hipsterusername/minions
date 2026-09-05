import { readSkillSnapshot, saveSkillSnapshot, selectSnapshotSkills } from "../skill-snapshot.ts";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  sourceSnapshotSchema,
  type SourceSnapshot,
} from "../../shared/task-graph-contracts.ts";
import type {
  SemanticTaskGraphPlan,
  TaskGraphPlanReviewRequirement,
} from "../../shared/task-graph-planning-contracts.ts";
import { compileSkills, loadSkillsByIds } from "../skills.ts";
import { computePacketApplicability } from "../system-model/applicability.ts";
import { loadSystemModel } from "../system-model/load.ts";
import { getWorkPacket } from "../system-model/store.ts";
import { readSettings } from "../project-store.ts";
import { TaskGraphValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { canonicalId } from "./planning-compiler.ts";
import { assertPlanningContextLimits } from "./planning-context-limits.ts";

const execFile = promisify(execFileCallback);

export interface PlanningSourceContext {
  workItemId: string;
  primaryRunKey: string;
  revisionId: string;
  workspaceId: string;
  cwd: string;
  projectPath: string;
  worktreeIdentity: string;
  connectedContext: string | null;
  skillIds: readonly string[];
  skillSnapshotId?: string | undefined;
  skillValues: Record<string, Record<string, string>>;
  harnessName: string;
  allowedTools: readonly string[];
  plan: SemanticTaskGraphPlan;
  nodeIdsByStepKey: Record<string, string>;
}

export interface ScopedContextSource {
  sourceSnapshotId: string;
  nodeId: string;
  sourceId: string;
  contentHash: string;
  classification: string;
  content: string;
}

export interface CapturedPlanningSource {
  snapshot: SourceSnapshot;
  fingerprint: string;
  scopedSources: ScopedContextSource[];
  policyAllowsAutoStart: boolean;
  startBlockedReason: string | null;
  reviewRequirements: TaskGraphPlanReviewRequirement[];
}

export interface FrozenRepositoryState {
  baseCommit: string;
  dirtyDigest: string;
}

export async function capturePlanningSource(
  input: PlanningSourceContext,
  at = Date.now(),
  inspectRepository: (cwd: string) => Promise<FrozenRepositoryState> = repositoryState,
): Promise<CapturedPlanningSource> {
  const repository = await inspectRepository(input.cwd);
  const canvasSources = splitConnectedContext(input.connectedContext);
  const skillSnapshot = input.skillSnapshotId ? readSkillSnapshot(input.projectPath, input.skillSnapshotId) : null;
  const requestedSkillIds = [...new Set(input.plan.steps.flatMap(step => step.skillIds ?? [...input.skillIds]))];
  const loadedSkills = skillSnapshot ? selectSnapshotSkills(skillSnapshot, requestedSkillIds)
    : loadSkillsByIds(input.projectPath, requestedSkillIds);
  for (const id of requestedSkillIds) {
    if (!loadedSkills.some(skill => skill.id === id)) {
      throw new TaskGraphValidationError(`Selected skill is unavailable in the frozen catalog: ${id}`);
    }
  }
  const skillSnapshotId = input.skillSnapshotId ?? (loadedSkills.length
    ? saveSkillSnapshot(input.projectPath, { version: 1, skills: loadedSkills, values: input.skillValues }) : undefined);
  const storedPacket = input.plan.workPacketId
    ? getWorkPacket(input.projectPath, input.plan.workPacketId) : null;
  const settings = readSettings(input.projectPath);
  const loadedModel = settings.systemModel && settings.systemModel !== "off"
    ? loadSystemModel(input.projectPath) : { model: null, errors: [] };
  const systemModelDigest = contentHash({
    mode: settings.systemModel ?? "off",
    model: loadedModel.model ? {
      manifest: loadedModel.model.manifest,
      domains: loadedModel.model.domains,
      capabilities: loadedModel.model.capabilities,
      flows: loadedModel.model.flows,
      constraints: loadedModel.model.constraints,
      decisions: loadedModel.model.decisions,
      risks: loadedModel.model.risks,
      surfaces: loadedModel.model.surfaces,
      policies: loadedModel.model.policies,
    } : null,
    errors: loadedModel.errors,
  });
  const policy = planningPolicy(input, storedPacket, settings.systemModel ?? "off", loadedModel);
  const compiledSkills = loadedSkills.map((skill) => {
    const values = input.skillValues[skill.id] ?? {};
    const content = compileSkills([skill], { [skill.id]: values });
    return {
      skillId: skill.id,
      version: contentHash({ skill }).slice("sha256:".length, "sha256:".length + 16),
      contentHash: contentHash(content),
      valuesHash: contentHash(values),
      content,
    };
  });
  const connectedRefs = canvasSources.map((source) => ({
    sourceId: source.sourceId, contentHash: contentHash(source.content), classification: "internal",
  }));
  const fingerprint = contentHash({
    repository,
    workspaceId: input.workspaceId,
    worktreeIdentity: input.worktreeIdentity,
    systemModelDigest,
    connectedRefs,
    skillSnapshotId,
    compiledSkills: compiledSkills.map(({ content: _content, ...skill }) => skill),
    workPacket: storedPacket?.packet ?? null,
    harnessName: input.harnessName,
    allowedTools: [...input.allowedTools].sort(),
  });
  const snapshotId = canonicalId("source", {
    workItemId: input.workItemId,
    primaryRunKey: input.primaryRunKey,
    revisionId: input.revisionId,
    fingerprint,
  });
  const snapshot = sourceSnapshotSchema.parse({
    id: snapshotId,
    workItemId: input.workItemId,
    primaryRunKey: input.primaryRunKey,
    taskGraphRevisionId: input.revisionId,
    repositoryBaseCommit: repository.baseCommit,
    dirtyDiffDigest: repository.dirtyDigest,
    workspaceId: input.workspaceId,
    worktreeIdentity: input.worktreeIdentity,
    systemModelDigest,
    workPacketRevisionId: storedPacket ? contentHash(storedPacket.packet) : null,
    connectedContext: connectedRefs,
    skillSnapshotId,
    compiledSkills: compiledSkills.map(({ content: _content, ...skill }) => skill),
    harnessPolicyDigest: contentHash({ harnessName: input.harnessName }),
    toolPolicyDigest: contentHash([...input.allowedTools].sort()),
    createdAt: at,
  });
  const scopedSources: ScopedContextSource[] = [];
  for (const step of input.plan.steps) {
    const nodeId = input.nodeIdsByStepKey[step.key]!;
    const matched = selectContext(canvasSources, step.contextSelectors);
    const requestedCanvas = canvasSelectorQueries(step.contextSelectors);
    if (requestedCanvas.length > 0 && matched.length === 0) {
      throw new TaskGraphValidationError(
        `Context selectors for step ${step.key} did not match frozen connected context: ${
          requestedCanvas.join(", ")}`,
      );
    }
    for (const source of matched) scopedSources.push({
      sourceSnapshotId: snapshotId,
      nodeId,
      sourceId: source.sourceId,
      contentHash: contentHash(source.content),
      classification: "internal",
      content: source.content,
    });
    for (const skill of compiledSkills.filter(skill => (step.skillIds ?? input.skillIds).includes(skill.skillId))) scopedSources.push({
      sourceSnapshotId: snapshotId,
      nodeId,
      sourceId: `skill:${skill.skillId}`,
      contentHash: skill.contentHash,
      classification: "internal",
      content: skill.content,
    });
    if (storedPacket) scopedSources.push({
      sourceSnapshotId: snapshotId,
      nodeId,
      sourceId: `work-packet:${storedPacket.packet.id}`,
      contentHash: contentHash(storedPacket.contextPack),
      classification: "internal",
      content: storedPacket.contextPack,
    });
  }
  assertPlanningContextLimits(scopedSources);
  return { snapshot, fingerprint, scopedSources,
    policyAllowsAutoStart: policy.startBlockedReason === null && policy.autoStart,
    startBlockedReason: policy.startBlockedReason,
    reviewRequirements: policy.reviewRequirements };
}

async function repositoryState(cwd: string): Promise<FrozenRepositoryState> {
  try {
    const [{ stdout: commit }, { stdout: diff }, { stdout: untracked }] = await Promise.all([
      git(cwd, ["rev-parse", "HEAD"]),
      git(cwd, ["diff", "--binary", "HEAD", "--"]),
      git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const paths = untracked.split("\0").filter(Boolean);
    const hashes: Array<[string, string]> = [];
    for (const file of paths) {
      const { stdout } = await git(cwd, ["hash-object", "--no-filters", "--", file]);
      hashes.push([path.normalize(file), stdout.trim()]);
    }
    return {
      baseCommit: commit.trim(),
      dirtyDigest: contentHash({ diff, untracked: hashes.sort(([a], [b]) => a.localeCompare(b)) }),
    };
  } catch (error) {
    throw new TaskGraphValidationError(`Unable to freeze repository source: ${
      error instanceof Error ? error.message : "Git inspection failed"}`);
  }
}

function planningPolicy(
  input: PlanningSourceContext,
  storedPacket: ReturnType<typeof getWorkPacket>,
  systemModelMode: "off" | "advisory" | "enforced",
  loaded: ReturnType<typeof loadSystemModel>,
): { startBlockedReason: string | null; autoStart: boolean;
  reviewRequirements: TaskGraphPlanReviewRequirement[] } {
  const blocked = (startBlockedReason: string) => ({
    startBlockedReason, autoStart: false, reviewRequirements: [],
  });
  if (input.plan.workPacketId && !storedPacket) {
    return blocked(`Work Packet ${input.plan.workPacketId} was not found.`);
  }
  if (systemModelMode !== "off") {
    if (!loaded.model) return blocked(`The active system model is invalid: ${
      loaded.errors[0]?.message ?? "model could not be loaded"}.`);
    const files = input.plan.steps.flatMap((step) => [
      ...step.ownershipRequest.filter((scope) => scope.scope === "path")
        .map((scope) => scope.normalizedValue),
      ...repositorySelectorQueries(step.contextSelectors),
    ]);
    const applicability = computePacketApplicability(loaded.model, files);
    if (applicability?.packetRequired && !storedPacket) return blocked(
      `A Work Packet is required for: ${[
        ...applicability.gateHits, ...applicability.constraintHits].join(", ")}.`,
    );
  }
  if (!storedPacket) return {
    startBlockedReason: null, autoStart: true, reviewRequirements: [],
  };
  const failedGate = storedPacket.packet.reviewGates.find((gate) => gate.status === "failed");
  if (failedGate) return blocked(`Work Packet gate ${failedGate.name} is failed.`);
  if (storedPacket.packet.freshness.status === "stale_blocked") {
    return blocked("Work Packet freshness checks are stale and blocking.");
  }
  const reviewRequirements = storedPacket.packet.reviewGates
    .filter((gate) => gate.status === "required_pending")
    .map((gate) => ({ gateId: gate.gateId, name: gate.name, reason: gate.reason }));
  // Pending review and partially-stale guidance are execution context, not a
  // request for user approval to begin work. Failed gates and stale_blocked
  // packets still stop execution above; merge-time gates remain authoritative.
  return { startBlockedReason: null, autoStart: true, reviewRequirements };
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

interface CanvasSource { sourceId: string; title: string; content: string }

function splitConnectedContext(value: string | null): CanvasSource[] {
  if (!value?.trim()) return [];
  const groups = [...value.matchAll(
    /<context-group(?:\s+title="([^"]*)")?>([\s\S]*?)<\/context-group>/g,
  )].map((match, index) => {
    const title = match[1] || `Connected context ${index + 1}`;
    return {
      sourceId: canonicalId("canvas", { index, title, content: match[2] }),
      title,
      content: match[0],
    };
  });
  return groups.length ? groups : [{
    sourceId: canonicalId("canvas", value), title: "Connected context", content: value,
  }];
}

function selectContext(sources: CanvasSource[], selectors: string[]): CanvasSource[] {
  const canvasSelectors = canvasSelectorQueries(selectors);
  if (!canvasSelectors.length || !sources.length) return [];
  const queries = canvasSelectors.map((selector) => selector.toLowerCase()
    .split(/[^a-z0-9]+/).filter((token) => token.length > 2)).filter((tokens) => tokens.length);
  return sources.filter((source) => {
    const title = source.title.toLowerCase();
    return queries.some((tokens) => tokens.every((token) => title.includes(token)));
  });
}

function canvasSelectorQueries(selectors: string[]): string[] {
  return selectors.filter((selector) => selector.toLowerCase().startsWith("canvas:"))
    .map((selector) => selector.slice(selector.indexOf(":") + 1).trim()).filter(Boolean);
}

function repositorySelectorQueries(selectors: string[]): string[] {
  return selectors.filter((selector) => selector.toLowerCase().startsWith("repo:"))
    .map((selector) => selector.slice(selector.indexOf(":") + 1).trim()).filter(Boolean);
}
