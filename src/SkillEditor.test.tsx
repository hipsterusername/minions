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
  attachments: [{
    kind: "text", filename: "rules.md", mediaType: "text/markdown",
    text: "Use the rules.", truncated: false,
  }],
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
    expect(saved.attachments?.[0]?.filename).toBe("rules.md");
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
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("Focus on safety.")).toBeInTheDocument();
  });

  it("keeps compiled instructions hidden until preview is requested", () => {
    const withVar: SkillTemplate = {
      ...baseSkill,
      subskills: [],
      template: "Focus on {{area}}.",
      variables: [
        { name: "area", label: "Area", type: "text", defaultValue: "safety" },
      ],
    };
    render(<SkillEditor skill={withVar} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Focus on safety.")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("Focus on safety.")).toBeVisible();
  });

  it("opens on Essentials and navigates categories via the side rail", () => {
    render(<SkillEditor skill={baseSkill} onSave={() => {}} onClose={() => {}} />);
    const accent = screen.getByText("Accent Color");
    expect(accent).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Appearance/ }));
    expect(accent).toBeVisible();
  });

  it("renders the existing sub-skill's fields in the Sub-skills section", () => {
    render(<SkillEditor skill={baseSkill} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Sub-skills").tagName).toBe("LABEL");
    expect(screen.getByText("+ Add sub-skill").tagName).toBe("BUTTON");
    expect(
      (screen.getByLabelText("Sub-skill 1 name") as HTMLInputElement).value,
    ).toBe("Layout");
    expect(
      (screen.getByLabelText("Sub-skill 1 id") as HTMLInputElement).value,
    ).toBe("layout");
  });
});

it("saves a chosen library icon with the skill and restores it when editing", () => {
  const onSave = vi.fn();
  const { unmount } = render(<SkillEditor skill={baseSkill} onSave={onSave} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Appearance/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search icons" }), { target: { value: "rocket" } });
  fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const saved = onSave.mock.calls[0]![0] as SkillTemplate;
  expect(saved.icon).toBe("minions:rocket");
  expect(saved.attachments).toEqual(baseSkill.attachments);
  unmount();
  render(<SkillEditor skill={saved} onSave={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Appearance/ }));
  expect(screen.getByRole("button", { name: "Rocket" })).toHaveAttribute("aria-pressed", "true");
});
