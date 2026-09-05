/** Shared, read-only skill retrieval for Minions. */
import { createSkillRetrievalTools } from "./skill-retrieval.ts";
export function createSubskillToolsForSession(opts: Parameters<typeof createSkillRetrievalTools>[0]) {
  return { toolDefs: createSkillRetrievalTools(opts) };
}
