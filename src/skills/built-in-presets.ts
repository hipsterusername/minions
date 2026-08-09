/**
 * Client adapter for the shared, code-authored skill presets.
 *
 * The single source of truth for these presets is `shared/skill-presets.ts`
 * (also consumed server-side for minion arming and the leader arming
 * inventory). Here we adapt them to the client `SkillTemplate` shape and mark
 * them `builtIn: true` so the UI can:
 *   - surface them in every skill picker (desktop + mobile), and
 *   - treat them as read-only: never persisted to `.minions/skills.json`,
 *     not deletable (editing creates a project override instead).
 *
 * `SkillPreset` is structurally identical to `SkillTemplate` (the type trees
 * are hand-mirrored because cross-tree imports between `shared/` consumers are
 * intentionally minimal), so the spread below is a safe adaptation.
 */

import { builtInSkillPresets } from "../../shared/skill-presets.ts";
import type { SkillTemplate } from "./types.ts";

/** All shared built-in presets, adapted to the client shape and flagged. */
export const builtInSkillTemplates: SkillTemplate[] = builtInSkillPresets.map(
  (preset): SkillTemplate => ({ ...preset, builtIn: true }),
);

/** Whether `id` names one of the shared built-in presets. */
export function isBuiltInSkillId(id: string): boolean {
  return builtInSkillTemplates.some((s) => s.id === id);
}
