import { SkillIcon } from "../../../components/SkillIcon.tsx";
import { getSkill } from "../../../skills/registry.ts";

export function SkillsPill({ skillIds, open, onOpen }: {
  skillIds: string[];
  open: boolean;
  onOpen: () => void;
}) {
  const count = skillIds.length;
  const skills = skillIds.map((id) => getSkill(id)).filter((skill) => skill !== undefined);

  return (
    <button
      type="button"
      className="leader-node__skills-button"
      onClick={onOpen}
      onMouseDown={(event) => event.stopPropagation()}
      data-active={count > 0}
      aria-label={`Configure skills${count > 0 ? `, ${count} active` : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`Skills · ${count} selected`}
    >
      <span>Skills</span>
      <strong aria-hidden="true">{count > 99 ? "99+" : count}</strong>
      {skills.length > 0 && (
        <span className="leader-node__skill-previews" aria-hidden="true">
          {skills.slice(0, 3).map((skill) => (
            <span key={skill.id} className="leader-node__skill-preview" title={skill.name} style={{ color: skill.accentColor }}>
              <SkillIcon skill={skill} size={13} />
            </span>
          ))}
          {skills.length > 3 && <span title={`${skills.length - 3} more selected skills`}>…</span>}
        </span>
      )}
    </button>
  );
}
