/** Compatibility factory; the Leader registers the full retrieval tool set. */
import { createSkillRetrievalTools } from "../skill-retrieval.ts";
import type { TaskToolContext } from "./types.ts";
export function createLoadSubskillToolDef(ctx: TaskToolContext) {
  return createSkillRetrievalTools({ projectPath: ctx.projectPath,
    skillSnapshotId: ctx.skillSnapshotId, skillValues: ctx.defaultMinionSkillValues })
    .find(tool => tool.name === "load_subskill")!;
}
