/**
 * Component tests for the canvas Skills browser's interaction hierarchy.
 *
 * Behaviour pinned:
 *   - Launch and management are revealed in a focused skill detail view.
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
    fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project Lint" }));
    expect(screen.getByRole("menuitem", { name: "Delete skill" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project Lint" }));
    fireEvent.click(screen.getByRole("button", { name: "All skills" }));
    fireEvent.click(screen.getByRole("button", { name: "View Skill Builder" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for Skill Builder" }));
    expect(screen.queryByRole("menuitem", { name: "Delete skill" })).not.toBeInTheDocument();
  });

  it("exposes duplicate and export actions and flows the skill through", () => {
    registerSkill(PROJECT_SKILL);
    const onExportSkill = vi.fn();
    const onDuplicateSkill = vi.fn();
    renderBrowser({ onExportSkill, onDuplicateSkill });
    fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));

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

  it("reveals an explicit launch action after selecting a skill", () => {
    registerSkill(PROJECT_SKILL);
    const onLaunchSkill = vi.fn();
    renderBrowser({ onLaunchSkill });
    expect(screen.queryByRole("button", { name: "Launch with Project Lint" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));

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

    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
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

    fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));
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

  it("preserves filters and returns focus when leaving skill details", () => {
    registerSkill(PROJECT_SKILL);
    renderBrowser();
    const search = screen.getByRole("searchbox", { name: "Search skills" });
    fireEvent.change(search, { target: { value: "  PROJECT lint  " } });
    expect(screen.getByRole("status")).toHaveTextContent("1 matching skill");
    expect(screen.queryByText("Skill Builder")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));
    expect(screen.getByRole("heading", { name: "Project Lint" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "All skills" }));
    expect(screen.getByRole("searchbox", { name: "Search skills" })).toHaveValue("  PROJECT lint  ");
    expect(screen.getByRole("button", { name: "View Project Lint" })).toHaveFocus();
  });

  it("dismisses the portaled menu on Tab and returns focus to its trigger", () => {
    registerSkill(PROJECT_SKILL);
    renderBrowser();
    fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));
    const trigger = screen.getByRole("button", { name: "More actions for Project Lint" });
    fireEvent.click(trigger);
    const item = screen.getByRole("menuitem", { name: "Edit skill" });
    item.focus();
    fireEvent.keyDown(item, { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Project Lint" })).toBeVisible();
  });
});

it("discloses instructions, inputs and reference context only on demand", () => {
  clearSkills();
  registerSkill({ ...PROJECT_SKILL, template: "Follow project rules.", variables: [{ name: "area", label: "Review area", type: "text", required: true }],
    attachments: [{ kind: "text", filename: "rules.md", mediaType: "text/markdown", text: "private reference body", truncated: false }],
    subskills: [{ id: "audit", name: "Audit", description: "Check dependencies", body: "Large audit instructions" }],
  });
  renderBrowser();
  expect(screen.queryByText("Instructions")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));
  expect(screen.getByText("Follow project rules.")).not.toBeVisible();
  fireEvent.click(screen.getByText("Instructions"));
  expect(screen.getByText("Follow project rules.")).toBeVisible();
  fireEvent.click(screen.getByText("Inputs"));
  expect(screen.getByText("Review area")).toBeVisible();
  expect(screen.getByText("Required")).toBeVisible();
  fireEvent.click(screen.getByText("Reference files"));
  expect(screen.getByText("rules.md")).toBeVisible();
  expect(screen.queryByText("private reference body")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Sub-skills"));
  expect(screen.getByText("Check dependencies")).toBeVisible();
  clearSkills();
});

it("lets users recover from empty filters and browse only their skills", () => {
  clearSkills(); registerSkill(PROJECT_SKILL); renderBrowser();
  fireEvent.click(screen.getByRole("button", { name: "Yours" }));
  expect(screen.getByRole("button", { name: "View Project Lint" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "View Skill Builder" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Skill category" }), { target: { value: "design" } });
  expect(screen.getByText("No matching skills")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  expect(screen.getByRole("button", { name: "View Skill Builder" })).toBeVisible();
  clearSkills();
});

it("Escape dismisses a nested menu before returning to the library", () => {
  clearSkills(); registerSkill(PROJECT_SKILL); renderBrowser();
  fireEvent.click(screen.getByRole("button", { name: "View Project Lint" }));
  fireEvent.click(screen.getByRole("button", { name: "More actions for Project Lint" }));
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit skill" }), { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  const heading = screen.getByRole("heading", { name: "Project Lint" });
  expect(heading).toBeVisible();
  fireEvent.keyDown(heading, { key: "Escape" });
  expect(screen.getByRole("button", { name: "View Project Lint" })).toHaveFocus();
  clearSkills();
});
