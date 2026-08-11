/**
 * Component tests for the canvas Skills browser's interaction hierarchy.
 *
 * Behaviour pinned:
 *   - Launch is a persistent, explicit primary action.
 *   - Secondary actions use labeled overflow menus instead of ambiguous glyphs.
 *   - Built-in presets have no delete affordance.
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

describe("SkillsBrowser", () => {
  beforeEach(() => clearSkills());
  afterEach(() => clearSkills());

  it("surfaces built-in presets with a badge and no delete button", () => {
    registerSkill(PROJECT_SKILL);
    renderBrowser();

    // Built-in surfaced despite the library holding only one project skill.
    expect(screen.getByText("Skill Builder")).toBeInTheDocument();
    expect(screen.getByText("Project Lint")).toBeInTheDocument();
    expect(screen.getAllByText("Built-in").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project Lint" }));
    expect(screen.getByRole("menuitem", { name: "Delete skill" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project Lint" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for Skill Builder" }));
    expect(screen.queryByRole("menuitem", { name: "Delete skill" })).not.toBeInTheDocument();
  });

  it("exposes duplicate and export actions and flows the skill through", () => {
    registerSkill(PROJECT_SKILL);
    const onExportSkill = vi.fn();
    const onDuplicateSkill = vi.fn();
    renderBrowser({ onExportSkill, onDuplicateSkill });

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project Lint" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export skill" }));
    expect(onExportSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj-lint" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project Lint" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate skill" }));
    expect(onDuplicateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "proj-lint" }),
    );
  });

  it("makes launch explicit and always available", () => {
    registerSkill(PROJECT_SKILL);
    const onLaunchSkill = vi.fn();
    renderBrowser({ onLaunchSkill });

    const launch = screen.getByRole("button", { name: "Launch with Project Lint" });
    expect(launch).toBeVisible();
    expect(launch).toHaveTextContent("Launch");

    fireEvent.click(launch);
    expect(onLaunchSkill).toHaveBeenCalledWith("proj-lint");
  });

  it("keeps the frequent create action visible and labels library actions", () => {
    const onCreateSkill = vi.fn();
    const onImportSkills = vi.fn();
    const onExportSkills = vi.fn();
    renderBrowser({ onCreateSkill, onImportSkills, onExportSkills });

    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(onCreateSkill).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Skill library actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Import skills" }));
    expect(onImportSkills).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Skill library actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export all skills" }));
    expect(onExportSkills).toHaveBeenCalledOnce();
  });

  it("closes an open action menu with Escape", () => {
    registerSkill(PROJECT_SKILL);
    renderBrowser();

    const more = screen.getByRole("button", { name: "More actions for Project Lint" });
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: "More actions for Project Lint" })).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("menu", { name: "More actions for Project Lint" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions for Project Lint" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
