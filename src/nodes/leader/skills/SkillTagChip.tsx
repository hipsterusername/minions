import { SkillIcon } from "../../../components/SkillIcon.tsx";
import { X } from "lucide-react";
import type { CSSProperties } from "react";
import type { SkillTemplate } from "../../../skills/types.ts";

/** Compact selected-skill label used above the configuration form. */
export function SkillTagChip({
  skill,
  onRemove,
  readOnly,
}: {
  skill: SkillTemplate;
  onRemove?: () => void;
  readOnly: boolean;
}) {
  return (
    <span
      className="skill-tag-chip"
      style={{ "--skill-color": skill.accentColor } as CSSProperties}
    >
      <span aria-hidden="true"><SkillIcon skill={skill} /></span>
      <span>{skill.name}</span>
      {skill.subskills && skill.subskills.length > 0 && (
        <span
          className="skill-tag-chip__subskills"
          title={`${skill.subskills.length} sub-skill${
            skill.subskills.length === 1 ? "" : "s"
          }`}
        >
          {skill.subskills.length} sub
        </span>
      )}
      {!readOnly && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={`Remove ${skill.name}`}
          aria-label={`Remove ${skill.name} from selected skills`}
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
