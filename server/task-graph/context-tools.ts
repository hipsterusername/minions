import { z } from "zod/v4";
import { MINION_CONTEXT_GUIDE } from "../../shared/minion-context.ts";
import { semanticGraphPlanStepSchema, semanticTaskGraphPlanSchema } from "../../shared/task-graph-planning-contracts.ts";
import { buildMinionSystemPrompt } from "../../shared/prompts/minion-context.ts";
import type { NormalizedToolDef } from "../harness/types.ts";
import { jsonResult } from "../harness/tool-result.ts";
import { readSkillSnapshot, selectSnapshotSkills } from "../skill-snapshot.ts";
import { compileSkills, loadSkillsByIds } from "../skills.ts";
import { getWorkPacket } from "../system-model/store.ts";
import type { PlanningSourceAuthority } from "./planning-coordinator.ts";
import { compileSemanticGraphPlan } from "./planning-compiler.ts";
import { selectContext, splitConnectedContext } from "./planning-source.ts";
import { renderTaskGraphNodePrompts, type ScopedContext } from "./node-prompt.ts";
import { assertPlanningContextLimits } from "./planning-context-limits.ts";
import { contentHash } from "./hash.ts";
import { TaskGraphValidationError } from "./errors.ts";

const inventorySchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
const previewSchema = z.object({
  step: semanticGraphPlanStepSchema,
  mission: z.object({
    objective: z.string().trim().min(1).max(4_000),
    constraints: z.array(z.string().trim().min(1).max(4_000)).max(30).default([]),
    nonGoals: z.array(z.string().trim().min(1).max(4_000)).max(30).default([]),
  }),
  workPacketId: z.string().min(1).optional(),
  includePrompts: z.boolean().default(false)
    .describe("Opt in to the composed Minions system/task text. Default returns size accounting, selected sources, and warnings only."),
});

const limitations = [
  "Only composed Minions context is measured. Provider base instructions, native tool schemas, skills/plugins, environment, server launch addenda, and message framing are excluded and may remain substantial.",
  "Approximate tokens use ceil(characters / 4), not the provider tokenizer or billed usage. Cached tokens still occupy input context.",
  "Preview does not create a graph, launch a child, freeze sources, or approve policy. Submission revalidates authority and freezes the selected sources.",
  "Runtime adds real attempt/source IDs, resolved artifact inputs, steering, recovery, and moderation when applicable. Provider-thread resumes also retain previous context.",
];

function measure(text: string) {
  return { characters: text.length, utf8Bytes: Buffer.byteLength(text), approximateTokens: Math.ceil(text.length / 4) };
}

export function createMinionContextTools(input: {
  resolveAuthority: () => PlanningSourceAuthority | null | Promise<PlanningSourceAuthority | null>;
}): NormalizedToolDef[] {
  async function authority() {
    const value = await input.resolveAuthority();
    if (!value) throw new TaskGraphValidationError("Minion context is outside the current Leader authority.");
    return value;
  }
  return [{
    name: "list_minion_context_blocks",
    description: "Discover Minion context blocks, when to use each, and a paged metadata-only inventory of available canvas sources and frozen skills. Use before an unfamiliar handoff; reuse the guidance for similar tasks.",
    inputSchema: inventorySchema,
    annotations: { readOnlyHint: true },
    handler: async raw => {
      const args = inventorySchema.parse(raw);
      const source = await authority();
      const snapshot = source.skillSnapshotId ? readSkillSnapshot(source.projectPath, source.skillSnapshotId) : null;
      const skills = snapshot?.skills ?? loadSkillsByIds(source.projectPath, [...source.skillIds]);
      const inventory = [
        ...splitConnectedContext(source.connectedContext).map(item => ({
          kind: "canvas", id: item.sourceId, title: item.title,
          selector: `canvas:${item.sourceId}`, ...measure(item.content),
        })),
        ...skills.map(skill => ({ kind: "skill", id: skill.id, title: skill.name,
          inherited: source.skillIds.includes(skill.id),
          ...measure(compileSkills([skill], { [skill.id]: source.skillValues[skill.id] ?? {} })),
        })),
      ];
      return jsonResult({ blocks: MINION_CONTEXT_GUIDE, limitations,
        inventory: inventory.slice(args.offset, args.offset + args.limit),
        nextOffset: args.offset + args.limit < inventory.length ? args.offset + args.limit : null,
        total: inventory.length,
        example: { context: { profile: "compact", instructions: [], references: [] },
          skillIds: [], contextSelectors: [], allowedTools: [] },
      });
    },
  }, {
    name: "preview_minion_context",
    description: "Compose one proposed graph Minion's context without launching it. Returns resolved canvas/skill/Work Packet blocks, size estimates, and warnings; optionally returns prompt text. Pass the same step to submit_graph_plan or upsert_graph_node. Use to check large or unfamiliar handoffs, not before every identical tiny task.",
    inputSchema: previewSchema,
    annotations: { readOnlyHint: true },
    handler: async raw => {
      const args = previewSchema.parse(raw);
      const source = await authority();
      const { step } = args;
      // Upstream nodes do not exist in this one-node preview. Their contracts
      // remain on the step; artifact identities/content are runtime additions.
      const plan = semanticTaskGraphPlanSchema.parse({ ...args.mission,
        acceptanceCriteria: step.acceptanceCriteria, steps: [{ ...step, dependsOn: [] }],
        terminalStepKeys: [step.key], maxActiveAttempts: 1,
      });
      const compiled = compileSemanticGraphPlan({ workItemId: "preview", primaryRunKey: "preview",
        workspaceId: source.workspaceId, proposalRevision: 1, plan,
        defaultHarness: source.harnessName, defaultAllowedTools: [...source.allowedTools] });
      const node = compiled.revision.nodes[0]!;
      const contexts: ScopedContext[] = selectContext(splitConnectedContext(source.connectedContext), step.contextSelectors)
        .map(item => ({ sourceId: item.sourceId, content: item.content,
          contentHash: contentHash(item.content), classification: "internal" }));
      const ids = [...new Set(step.skillIds ?? source.skillIds)];
      const snapshot = source.skillSnapshotId ? readSkillSnapshot(source.projectPath, source.skillSnapshotId) : null;
      const skills = snapshot ? selectSnapshotSkills(snapshot, ids) : loadSkillsByIds(source.projectPath, ids);
      for (const id of ids) {
        if (!skills.some(skill => skill.id === id)) throw new TaskGraphValidationError(`Selected skill is unavailable in the frozen catalog: ${id}`);
      }
      for (const skill of skills) {
        const content = compileSkills([skill], { [skill.id]: source.skillValues[skill.id] ?? {} });
        contexts.push({ sourceId: `skill:${skill.id}`, content, contentHash: contentHash(content), classification: "internal" });
      }
      if (args.workPacketId) {
        const packet = getWorkPacket(source.projectPath, args.workPacketId);
        if (!packet) throw new TaskGraphValidationError(`Work Packet ${args.workPacketId} was not found.`);
        contexts.push({ sourceId: `work-packet:${packet.packet.id}`, content: packet.contextPack,
          contentHash: contentHash(packet.contextPack), classification: "internal" });
      }
      assertPlanningContextLimits(contexts.map(item => ({ ...item, sourceSnapshotId: "preview", nodeId: node.id })));
      const composed = renderTaskGraphNodePrompts(compiled.revision, node,
        "preview-attempt", 1, "preview-source", [], [], contexts);
      const systemPrompt = composed.systemPrompt ?? buildMinionSystemPrompt();
      const taskPrompt = composed.prompt;
      const warnings: string[] = [];
      if (step.skillIds === undefined && ids.length) warnings.push("skillIds omitted: Leader-selected skills are inherited. Use [] when no optional Minions playbook is needed.");
      if (step.contextSelectors.some(selector => selector.startsWith("repo:"))) warnings.push("repo: selectors do not inject file contents; supply focused reference excerpts or let the Minion read permitted paths.");
      if (step.dependsOn.length || Object.keys(step.inputBindings).length) warnings.push("Artifact dependencies are not resolved in this preview.");
      if (step.sessionAffinity) warnings.push("Provider-thread history is retained; a compact profile does not clear previous context.");
      if (step.context?.profile === "compact" && (node.ownershipRequest.some(scope => scope.mode === "write")
        || step.completionMode === "verification")) warnings.push("This task writes files or performs structured verification; consider standard for its fuller operating guidance.");
      const total = measure(systemPrompt + taskPrompt);
      if (total.characters > 24_000) warnings.push("Composed Minions context exceeds 24,000 characters. Narrow selectors, skills, or reference excerpts.");
      return jsonResult({ profile: step.context?.profile ?? "standard", resolvedSkillIds: ids,
        blocks: [
          { id: "system", ...measure(systemPrompt) },
          { id: "task", ...measure(taskPrompt) },
        ],
        // These are portions of task, not additional counts to add to total.
        taskSourceBreakdown: contexts.map(item => ({ id: item.sourceId, contentHash: item.contentHash, ...measure(item.content) })),
        inlineReferences: (step.context?.references ?? []).map(ref => ({ id: ref.id, ...measure(ref.content) })),
        total, warnings, limitations,
        ...(args.includePrompts ? { systemPrompt, taskPrompt } : {}),
      });
    },
  }];
}
