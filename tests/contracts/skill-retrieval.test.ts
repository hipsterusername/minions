import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkillRetrievalTools } from "../../server/skill-retrieval.ts";
import { minionSkillMcpToolNames } from "../../server/agents/minion-tool-policy.ts";
import { LEGACY_LEADER_TASK_TOOL_NAMES, TASK_GRAPH_LEADER_TASK_TOOL_NAMES } from "../../shared/leader-planning.ts";
import { composeLeaderPrompt } from "../../shared/leader-prompt.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-contract-"));
  vi.stubEnv("MINIONS_HOME", path.join(root, "state"));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

it("advertises exactly the read-only retrieval tools in both Leader modes and the Minion allowlist", async () => {
  const definitions = createSkillRetrievalTools({ projectPath: root });
  const names = definitions.map(def => def.name);
  expect(names).toEqual(["load_skill", "load_subskill", "load_skill_attachment"]);
  expect(minionSkillMcpToolNames([])).toEqual(names.map(name => `mcp__skills__${name}`));
  for (const mode of [LEGACY_LEADER_TASK_TOOL_NAMES, TASK_GRAPH_LEADER_TASK_TOOL_NAMES]) {
    const prompt = composeLeaderPrompt({ builtInTools: [], registeredToolNames: mode });
    for (const name of names) { expect(mode).toContain(name); expect(prompt).toContain(name); }
  }
  const parent = definitions.find(def => def.name === "load_skill")!;
  expect(parent.inputSchema.parse({ skillId: "skill-builder" })).toEqual({ skillId: "skill-builder" });
  const result = await parent.handler({ skillId: "skill-builder" });
  expect(JSON.stringify(result)).toContain("Skill Builder");
  expect(names).not.toContain("create_skill");
});
