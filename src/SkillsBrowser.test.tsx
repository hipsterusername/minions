/**
 * Component test for SkillsBrowser's built-in-preset surfacing.
 *
 * Behaviour pinned:
 *   - Built-in presets (e.g. "Skill Builder") appear in the browser even with
 *     an empty project library, tagged with a "built-in" badge.
 *   - Built-in presets have no delete affordance (code-authored, not deletable);
 *     project skills keep theirs.
 */
import { useEffect, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DockProvider, useDock } from "./BottomRightDock.tsx";
import { SkillsBrowser } from "./SkillsBrowser.tsx";
import { clearSkills, registerSkill } from "./skills/registry.ts";
import type { SkillTemplate } from "./skills/types.ts";

function OpenSkillsPanel() {
  const { openPanel } = useDock();
  useEffect(() => openPanel("skills"), [openPanel]);
  return null;
}

function renderBrowser(overrides: Partial<ComponentProps<typeof SkillsBrowser>> = {}) {
  return render(
    <DockProvider>
      <OpenSkillsPanel />
      <SkillsBrowser
        onLaunchSkill={vi.fn()}
        onCreateSkill={vi.fn()}
        onEditSkill={vi.fn()}
        onDeleteSkill={vi.fn()}
        onDuplicateSkill={vi.fn()}
        onExportSkill={vi.fn()}
        onImportSkills={vi.fn()}
        onExportSkills={vi.fn()}
        onImportFile={vi.fn()}
        {...overrides}
      />
    </DockProvider>,
  );
}

const PROJECT_SKILL: SkillTemplate = {
  id: "proj-lint",
  name: "Project Lint",
  description: "a project skill",
  category: "code",
  icon: "P",
  accentColor: "#000",
  template: "BODY",
  variables: [],
};

describe("SkillsBrowser built-in presets", () => {
  beforeEach(() => clearSkills());
  afterEach(() => clearSkills());

  it("surfaces built-in presets with a badge and no delete button", () => {
    registerSkill(PROJECT_SKILL);
    renderBrowser();

    // Built-in surfaced despite the library holding only one project skill.
    expect(screen.getByText("Skill Builder")).toBeInTheDocument();
    expect(screen.getByText("Project Lint")).toBeInTheDocument();
    expect(screen.getAllByText("built-in").length).toBeGreaterThanOrEqual(1);

    // Only the project skill is deletable; built-ins are not.
    expect(screen.getAllByTitle("Delete skill")).toHaveLength(1);
  });

  it("exposes duplicate and export actions and flows the skill through", () => {
    registerSkill(PROJECT_SKILL);
    const onExportSkill = vi.fn();
    const onDuplicateSkill = vi.fn();
    renderBrowser({ onExportSkill, onDuplicateSkill });

    // Every card (project skill + built-ins) carries both actions.
    expect(screen.getAllByTitle("Export skill").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTitle("Duplicate skill").length).toBeGreaterThanOrEqual(1);

    // The project skill (category "code") renders first, so its buttons lead.
    fireEvent.click(screen.getAllByTitle("Export skill")[0]!);
    expect(onExportSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj-lint" }),
    );

    fireEvent.click(screen.getAllByTitle("Duplicate skill")[0]!);
    expect(onDuplicateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj-lint" }),
    );
  });

  it("keeps per-card actions mounted but reveals them only on hover", () => {
    registerSkill(PROJECT_SKILL);
    renderBrowser();

    const editBtn = screen.getAllByTitle("Edit skill")[0]!;
    const actions = editBtn.parentElement!; // the actions grid
    const card = actions.parentElement!; // the card row

    // Mounted (so keyboard + tests reach them) but visually hidden at rest.
    expect(actions.style.opacity).toBe("0");

    fireEvent.mouseEnter(card);
    expect(actions.style.opacity).toBe("1");

    fireEvent.mouseLeave(card);
    expect(actions.style.opacity).toBe("0");
  });
});
