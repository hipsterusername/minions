import { describe, expect, it } from "vitest";
import { semanticTaskGraphPlanSchema } from "../../shared/task-graph-planning-contracts.ts";
import { graphRevisionInputSchema } from "../../shared/task-graph-contracts.ts";
import { TASK_GRAPH_PLANNING_TOOL_NAMES } from "../../shared/leader-planning.ts";
import { compileSemanticGraphPlan } from "../../server/task-graph/planning-compiler.ts";
import { createMinionContextTools } from "../../server/task-graph/context-tools.ts";

describe("Leader Minion context contract", () => {
  it("advertises read-only construction tools and carries explicit context into immutable revisions", () => {
    const tools = createMinionContextTools({ resolveAuthority: () => null });
    for (const tool of tools) {
      expect(TASK_GRAPH_PLANNING_TOOL_NAMES).toContain(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    const plan = semanticTaskGraphPlanSchema.parse({ objective: "Colors", acceptanceCriteria: ["red"],
      steps: [{ key: "red", title: "Red", objective: "Return red", acceptanceCriteria: ["red"],
        skillIds: [], context: { profile: "compact", instructions: ["Say one word, and one word only red"] } }] });
    const args = { workItemId: "work", workspaceId: "workspace", primaryRunKey: "leader", proposalRevision: 1,
      plan, defaultHarness: "codex", defaultAllowedTools: [] };
    const compiled = compileSemanticGraphPlan(args);
    const roundTrip = graphRevisionInputSchema.parse(JSON.parse(JSON.stringify(compiled.revision)));
    expect(roundTrip.nodes[0]?.context).toEqual(plan.steps[0]?.context);
    const changed = structuredClone(plan);
    changed.steps[0]!.context!.instructions = ["Return blue"];
    expect(compileSemanticGraphPlan({ ...args, plan: changed }).revision.revisionId)
      .not.toBe(compiled.revision.revisionId);
  });
});
