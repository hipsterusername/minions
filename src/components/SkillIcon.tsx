import type { SkillTemplate } from "../skills/types.ts";
import { MinionsIcon, isMinionsIconName, type MinionsIconName } from "./MinionsIcon.tsx";
import { SKILL_ICON_PREFIX } from "../skills/icon-library.ts";

const categoryIcons: Record<SkillTemplate["category"], MinionsIconName> = {
  code: "code", docs: "file", testing: "testing", devops: "devops",
  analysis: "analysis", design: "appearance", general: "skill",
};

// Legacy badges remain intact in storage/import/export. Resolve their artwork
// here so every launcher, tag and editor preview uses the same visual language.
const legacyIcons: Record<string, MinionsIconName> = {
  "⚡": "skill", "✨": "skill", "✦": "skill", "🌟": "skill", "⭐": "skill",
  "🎨": "appearance", "🖌": "appearance", "🖼": "appearance",
  "💻": "code", "🧑‍💻": "code", "👩‍💻": "code", "👨‍💻": "code",
  "📝": "file", "📄": "file", "📋": "file", "📚": "file", "📖": "file",
  "🧪": "testing", "🔬": "testing", "🐛": "testing", "✅": "check",
  "🚀": "devops", "🛠": "settings", "🔧": "settings", "⚙": "settings",
  "🔍": "analysis", "🔎": "analysis", "📊": "analysis", "📈": "analysis",
  "📁": "folder", "📂": "folder-open", "⏳": "wait", "⌛": "wait",
  "🔄": "retry", "⚠": "warning", "❌": "close", "⏸": "pause",
};

export function SkillIcon({ skill, size = 16 }: {
  skill: Pick<SkillTemplate, "icon" | "category">;
  size?: number;
}) {
  const badge = skill.icon.trim();
  if (badge.startsWith(SKILL_ICON_PREFIX)) {
    const name = badge.slice(SKILL_ICON_PREFIX.length);
    return <MinionsIcon name={isMinionsIconName(name) ? name : categoryIcons[skill.category]} size={size} />;
  }
  const normalized = badge.replace(/[\uFE0E\uFE0F]/g, "");
  const knownIcon = Object.hasOwn(legacyIcons, normalized) ? legacyIcons[normalized] : undefined;
  // Include flags and keycaps, which Extended_Pictographic alone misses.
  const isEmoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(badge);
  if (knownIcon || isEmoji || !badge) {
    return <MinionsIcon name={knownIcon ?? categoryIcons[skill.category]} size={size} />;
  }
  return <span aria-hidden="true">{skill.icon}</span>;
}
