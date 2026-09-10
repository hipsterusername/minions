import { makeTaskGraphTempDir } from "./test-helpers.ts";
import { describe, expect, it } from "vitest";
import { createMinionContextTools } from "./context-tools.ts";
import type { PlanningSourceAuthority } from "./planning-coordinator.ts";
import { capturePlanningSource, splitConnectedContext } from "./planning-source.ts";
import { semanticTaskGraphPlanSchema } from "../../shared/task-graph-planning-contracts.ts";
import { saveSkillSnapshot } from "../skill-snapshot.ts";
import { MINION_SYSTEM_PROMPT } from "../../shared/prompts/minion-system.ts";

const canvas = '<context-group title="UI">UI_REFERENCE</context-group><context-group title="Billing">BILLING_REFERENCE</context-group>';
function authority(): PlanningSourceAuthority {
  const projectPath = makeTaskGraphTempDir();
  const skill = { id: "check", name: "Check", description: "Review checks", category: "general" as const,
    icon: "*", accentColor: "#fff", template: "FROZEN_CHECKS", variables: [] };
  const skillSnapshotId = saveSkillSnapshot(projectPath, { version: 1, skills: [skill], values: {} });
  return { workspaceId: "workspace", cwd: projectPath, projectPath, worktreeIdentity: "workspace",
    connectedContext: canvas, skillIds: ["check"], skillSnapshotId, skillValues: {}, harnessName: "codex", allowedTools: [] };
}
const step = { key: "red", title: "Red", objective: "Return red", acceptanceCriteria: ["red"] };

async function call(source: PlanningSourceAuthority | null, name: string, args: unknown) {
  const tool = createMinionContextTools({ resolveAuthority: () => source }).find(item => item.name === name)!;
  const result = await tool.handler(args) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("Minion context tools", () => {
  it("lists metadata in bounded pages without leaking reference or skill bodies", async () => {
    const source = authority();
    const page = await call(source, "list_minion_context_blocks", { limit: 1 });
    expect(page.inventory).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    expect(JSON.stringify(page)).not.toContain("UI_REFERENCE");
    expect(JSON.stringify(page)).not.toContain("FROZEN_CHECKS");
    const next = await call(source, "list_minion_context_blocks", { offset: 1, limit: 2 });
    expect(next.inventory).toHaveLength(2);
    expect(next.nextOffset).toBeUndefined(); // Tool transport omits null fields.
    expect(next.inventory[1]).toMatchObject({ id: "check", inherited: true });
  });

  it("previews compact instructions, explicit empty skills, and exact selected references", async () => {
    const source = authority();
    const selector = `canvas:${splitConnectedContext(canvas)[0]!.sourceId}`;
    const previewStep = { ...step, skillIds: [], contextSelectors: [selector],
      context: { profile: "compact", instructions: ["ONE_WORD"], references: [{ id: "sample", title: "Sample", content: "INLINE_DATA" }] } };
    const args = { step: previewStep, mission: { objective: "Colors", constraints: ["Preserve files"] }, includePrompts: true };
    const preview = await call(source, "preview_minion_context", args);
    expect(preview.systemPrompt).toContain("ONE_WORD");
    expect(preview.systemPrompt).not.toContain("INLINE_DATA");
    expect(preview.systemPrompt.length).toBeLessThan(MINION_SYSTEM_PROMPT.length);
    expect(preview.taskPrompt).toContain("INLINE_DATA");
    expect(preview.taskPrompt).toContain("UI_REFERENCE");
    expect(preview.taskPrompt).not.toContain("BILLING_REFERENCE");
    expect(preview.taskPrompt).not.toContain("FROZEN_CHECKS");
    expect(preview.taskPrompt).toContain("Preserve files");
    expect(preview.taskPrompt).toContain("filesystem read-only");
    expect(preview.total.characters).toBe(preview.systemPrompt.length + preview.taskPrompt.length);
    expect(preview.limitations.join(" ")).toContain("Provider base instructions");
    const compact = await call(source, "preview_minion_context", { ...args, includePrompts: false });
    expect(compact).not.toHaveProperty("systemPrompt");
    expect(compact).not.toHaveProperty("taskPrompt");
    const plan = semanticTaskGraphPlanSchema.parse({ objective: "Colors", acceptanceCriteria: ["red"], steps: [previewStep] });
    const captured = await capturePlanningSource({ ...source, workItemId: "work", primaryRunKey: "leader",
      revisionId: "revision", plan, nodeIdsByStepKey: { red: "node" } }, 1,
      async () => ({ baseCommit: "abc", dirtyDigest: `sha256:${"a".repeat(64)}` }));
    expect(preview.taskSourceBreakdown.map((item: { contentHash: string }) => item.contentHash))
      .toEqual(captured.scopedSources.map(item => item.contentHash));
  });

  it("explains inherited skills and rejects missing sources even when another selector matches", async () => {
    const source = authority();
    const result = await call(source, "preview_minion_context", { step, mission: { objective: "Colors" }, includePrompts: true });
    expect(result.resolvedSkillIds).toEqual(["check"]);
    expect(result.taskPrompt).toContain("FROZEN_CHECKS");
    expect(result.warnings.join(" ")).toContain("inherited");
    await expect(call(source, "preview_minion_context", { step: { ...step, contextSelectors: ["canvas:UI", "canvas:Missing"] }, mission: { objective: "Colors" } })).rejects.toThrow(/did not match/);
    await expect(call(source, "preview_minion_context", { step: { ...step, skillIds: ["missing"] }, mission: { objective: "Colors" } })).rejects.toThrow(/unavailable/);
    await expect(call(null, "list_minion_context_blocks", {})).rejects.toThrow(/authority/);
  });
});
