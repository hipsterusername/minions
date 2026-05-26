import type { SkillTemplate } from "../../../skills/types.ts";

/**
 * A pill-shaped chip that displays a single armed skill. Shows the icon
 * + name, color-themed via the skill's `accentColor`. In editable mode a
 * small ✕ button removes the skill.
 *
 * Extracted from `src/nodes/LeaderNode.tsx` (Phase 6 of the leader refactor).
 */
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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        background: `${skill.accentColor}20`,
        border: `1px solid ${skill.accentColor}40`,
        color: skill.accentColor,
      }}
    >
      <span>{skill.icon}</span>
      <span>{skill.name}</span>
      {!readOnly && onRemove && (
        <button
          onClick={onRemove}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            background: "none",
            border: "none",
            color: skill.accentColor,
            cursor: "pointer",
            padding: 0,
            fontSize: 10,
            lineHeight: 1,
            opacity: 0.6,
          }}
        >
          ✕
        </button>
      )}
    </span>
  );
}
