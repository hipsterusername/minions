/**
 * Component test for SkillEditor — focused on sub-skill round-tripping through
 * save (the rest of the editor is exercised indirectly elsewhere).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillEditor } from "./SkillEditor.tsx";
import type { SkillTemplate } from "./skills/types.ts";

const baseSkill: SkillTemplate = {
  id: "design",
  name: "Design",
  description: "A design skill",
  category: "design",
  icon: "🎨",
  accentColor: "#0f766e",
  template: "Base body",
  variables: [],
  subskills: [
    { id: "layout", name: "Layout", description: "layout rules", body: "BODY" },
  ],
};

describe("SkillEditor sub-skills", () => {
  it("preserves existing sub-skills through save", () => {
    const onSave = vi.fn();
    render(
      <SkillEditor skill={baseSkill} onSave={onSave} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as SkillTemplate;
    expect(saved.subskills).toEqual([
      { id: "layout", name: "Layout", description: "layout rules", body: "BODY" },
    ]);
  });

  it("omits sub-skills entirely when none have a name", () => {
    const onSave = vi.fn();
    const flat: SkillTemplate = { ...baseSkill, subskills: [] };
    render(<SkillEditor skill={flat} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Save"));
    const saved = onSave.mock.calls[0]![0] as SkillTemplate;
    expect("subskills" in saved).toBe(false);
  });

  it("shows a compiled preview with substituted defaults on demand", () => {
    const withVar: SkillTemplate = {
      ...baseSkill,
      subskills: [],
      template: "Focus on {{area}}.",
      variables: [
        { name: "area", label: "Area", type: "text", defaultValue: "safety" },
      ],
    };
    render(<SkillEditor skill={withVar} onSave={() => {}} onClose={() => {}} />);
    // Preview is collapsed by default; expand it.
    fireEvent.click(screen.getByText("Compiled preview"));
    expect(screen.getByText("Focus on safety.")).toBeInTheDocument();
  });

  it("keeps the compiled preview visible without interaction (sticky pane)", () => {
    const withVar: SkillTemplate = {
      ...baseSkill,
      subskills: [],
      template: "Focus on {{area}}.",
      variables: [
        { name: "area", label: "Area", type: "text", defaultValue: "safety" },
      ],
    };
    render(<SkillEditor skill={withVar} onSave={() => {}} onClose={() => {}} />);
    // No click needed — the preview lives in the always-on right pane.
    expect(screen.getByText("Focus on safety.")).toBeInTheDocument();
  });

  it("opens on Essentials and navigates categories via the side rail", () => {
    render(<SkillEditor skill={baseSkill} onSave={() => {}} onClose={() => {}} />);
    // Every panel is mounted, but only the active one is visible. Appearance
    // (Accent Color) starts hidden; clicking its rail entry reveals it.
    const accent = screen.getByText("Accent Color");
    expect(accent).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Appearance/ }));
    expect(accent).toBeVisible();
  });

  it("renders the existing sub-skill's fields in the Sub-skills section", () => {
    render(<SkillEditor skill={baseSkill} onSave={() => {}} onClose={() => {}} />);
    // The section header and add control are present…
    expect(screen.getByText("Sub-skills").tagName).toBe("LABEL");
    expect(screen.getByText("+ Add sub-skill").tagName).toBe("BUTTON");
    // …and the tagged skill's sub-skill is populated into the editor.
    expect(
      (screen.getByLabelText("Sub-skill 1 name") as HTMLInputElement).value,
    ).toBe("Layout");
    expect(
      (screen.getByLabelText("Sub-skill 1 id") as HTMLInputElement).value,
    ).toBe("layout");
  });
});
