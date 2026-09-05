import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { SKILL_ICON_GROUPS, SKILL_ICON_LIBRARY, SKILL_ICON_PREFIX } from "../skills/icon-library.ts";
import type { SkillTemplate } from "../skills/types.ts";
import { MinionsIcon } from "./MinionsIcon.tsx";
import { SkillIcon } from "./SkillIcon.tsx";
import "./skill-icon-picker.css";

export function SkillIconPicker({ value, onChange, category, accentColor, description = "Your skill’s signature across the workspace.", allowCustomBadge = true }: {
  value: string;
  onChange: (value: string) => void;
  category: SkillTemplate["category"];
  accentColor: string;
  description?: string;
  allowCustomBadge?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("All icons");
  const [focused, setFocused] = useState("");
  const selected = SKILL_ICON_LIBRARY.find((icon) => `${SKILL_ICON_PREFIX}${icon.name}` === value);
  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/);
    return SKILL_ICON_LIBRARY.filter((icon) =>
      (group === "All icons" || icon.group === group) &&
      terms.every((term) => `${icon.label} ${icon.name} ${icon.group} ${icon.keywords}`.toLowerCase().includes(term)),
    );
  }, [search, group]);
  const tabStop = filtered.find((icon) => icon.name === focused)?.name
    ?? filtered.find((icon) => icon.name === selected?.name)?.name ?? filtered[0]?.name;

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const columns = getComputedStyle(event.currentTarget).gridTemplateColumns.split(" ").length;
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key] ?? 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + delta));
    buttons[next]?.focus();
  }

  return (
    <div className="skill-icon-picker" style={{ "--skill-accent": accentColor } as React.CSSProperties}>
      <div className="skill-icon-picker__selection">
        <span className="skill-icon-picker__preview"><SkillIcon skill={{ icon: value, category }} size={26} /></span>
        <div><strong>{selected?.label ?? "Custom / legacy badge"}</strong><p>{description}</p></div>
      </div>
      <div className="skill-icon-picker__filters">
        <label className="skill-icon-picker__search">
          <MinionsIcon name="analysis" />
          <input type="search" aria-label="Search icons" placeholder="Search icons, e.g. security" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <select aria-label="Icon category" value={group} onChange={(event) => setGroup(event.target.value)}>
          <option>All icons</option>
          {SKILL_ICON_GROUPS.map((name) => <option key={name}>{name}</option>)}
        </select>
      </div>
      <p className="skill-icon-picker__count" id={`${id}-hint`}>
        <span role="status">{filtered.length} icons</span><span>Arrow keys to explore · Enter to select</span>
      </p>
      {filtered.length ? (
        <div className="skill-icon-picker__grid" role="group" aria-label="Icon library" aria-describedby={`${id}-hint`} onKeyDown={navigate}>
          {filtered.map((icon) => (
            <button key={icon.name} type="button" aria-label={icon.label} title={`${icon.label} · ${icon.group}`}
              aria-pressed={selected?.name === icon.name} tabIndex={tabStop === icon.name ? 0 : -1}
              onFocus={() => setFocused(icon.name)} onClick={() => onChange(`${SKILL_ICON_PREFIX}${icon.name}`)}>
              <MinionsIcon name={icon.name} size={22} />
            </button>
          ))}
        </div>
      ) : (
        <div className="skill-icon-picker__empty"><strong>No icons found</strong><p>Try a different word or category.</p>
          <button type="button" onClick={() => { setSearch(""); setGroup("All icons"); }}>Reset filters</button>
        </div>
      )}
      {allowCustomBadge && <details className="skill-icon-picker__custom">
        <summary>Use a custom text badge</summary>
        <label htmlFor={`${id}-custom`}>Letters or a symbol</label>
        <input id={`${id}-custom`} value={value.startsWith(SKILL_ICON_PREFIX) ? "" : value} maxLength={4}
          placeholder="e.g. UX or λ" onChange={(event) => onChange(event.target.value)} />
      </details>}
    </div>
  );
}
