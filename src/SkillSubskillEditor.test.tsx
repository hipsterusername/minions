/**
 * Component test for SkillSubskillEditor — the controlled sub-skill list editor.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  SkillSubskillEditor,
  generateSubskillId,
} from "./SkillSubskillEditor.tsx";
import type { SubSkill } from "./skills/types.ts";

describe("generateSubskillId", () => {
  it("slugifies a name", () => {
    expect(generateSubskillId("Layout Rules!")).toBe("layout-rules");
    expect(generateSubskillId("  Deep   Dive  ")).toBe("deep-dive");
    expect(generateSubskillId("")).toBe("");
  });
});

describe("SkillSubskillEditor", () => {
  it("adds an empty sub-skill when the add button is clicked", () => {
    const onChange = vi.fn();
    render(<SkillSubskillEditor subskills={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText("+ Add sub-skill"));
    expect(onChange).toHaveBeenCalledWith([
      { id: "", name: "", description: "", body: "" },
    ]);
  });

  it("auto-derives the id from the name on edit", () => {
    const onChange = vi.fn();
    const subs: SubSkill[] = [
      { id: "", name: "", description: "", body: "" },
    ];
    render(<SkillSubskillEditor subskills={subs} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Sub-skill 1 name"), {
      target: { value: "Layout Rules" },
    });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "Layout Rules", id: "layout-rules" }),
    ]);
  });

  it("toggles alwaysInclude", () => {
    const onChange = vi.fn();
    const subs: SubSkill[] = [
      { id: "s", name: "S", description: "d", body: "b" },
    ];
    render(<SkillSubskillEditor subskills={subs} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Sub-skill 1 always include"));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ alwaysInclude: true }),
    ]);
  });

  it("removes a sub-skill", () => {
    const onChange = vi.fn();
    const subs: SubSkill[] = [
      { id: "a", name: "A", description: "", body: "" },
      { id: "b", name: "B", description: "", body: "" },
    ];
    render(<SkillSubskillEditor subskills={subs} onChange={onChange} />);
    fireEvent.click(screen.getAllByText("Remove")[0]!);
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "b" }),
    ]);
  });

  it("removes context attached to a sub-skill", () => {
    const onChange = vi.fn();
    render(<SkillSubskillEditor subskills={[{
      id: "s", name: "S", description: "d", body: "b",
      attachments: [{
        kind: "text", filename: "rules.md", mediaType: "text/markdown",
        text: "rules", truncated: false,
      }],
    }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove rules.md" }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "s", attachments: [] }),
    ]);
  });
});
