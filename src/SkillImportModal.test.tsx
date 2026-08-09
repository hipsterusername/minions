import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillImportModal } from "./SkillImportModal.tsx";
import type { SkillTemplate } from "./skills/types.ts";

function skill(id: string, name = id): SkillTemplate {
  return {
    id,
    name,
    description: `${name} desc`,
    category: "code",
    icon: "⚡",
    accentColor: "#000",
    template: "body",
    variables: [],
  };
}

describe("SkillImportModal", () => {
  it("flags new vs. overwriting skills", () => {
    render(
      <SkillImportModal
        incoming={[skill("a"), skill("b")]}
        existingIds={new Set(["b"])}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Overwrites")).toBeInTheDocument();
    expect(screen.getByText(/1 overwrite/)).toBeInTheDocument();
  });

  it("imports only the selected skills", () => {
    const onConfirm = vi.fn();
    render(
      <SkillImportModal
        incoming={[skill("a"), skill("b")]}
        existingIds={new Set()}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    // Everything starts selected; deselect "a" via its checkbox (first one).
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const selected = onConfirm.mock.calls[0]![0] as SkillTemplate[];
    expect(selected.map((s) => s.id)).toEqual(["b"]);
  });

  it("disables import when nothing is selected", () => {
    render(
      <SkillImportModal
        incoming={[skill("a")]}
        existingIds={new Set()}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Deselect all/ }));
    expect(screen.getByRole("button", { name: /Import/ })).toBeDisabled();
  });

  it("shows the skipped-entries note", () => {
    render(
      <SkillImportModal
        incoming={[skill("a")]}
        existingIds={new Set()}
        skipped={2}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 skipped/)).toBeInTheDocument();
  });
});
