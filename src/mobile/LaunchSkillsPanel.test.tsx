import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SkillTemplate } from "../skills/types.ts";
import { LaunchSkillsPanel } from "./LaunchSkillsPanel.tsx";

const CODE_SKILL: SkillTemplate = {
  id: "lint",
  name: "Lint Cleanup",
  description: "Fix lint violations",
  category: "code",
  icon: "🧹",
  accentColor: "#7c3aed",
  template: "Clean up lint in {{scope}}.",
  variables: [
    { name: "scope", label: "Scope", type: "text", placeholder: "src/" },
  ],
};

const DOCS_SKILL: SkillTemplate = {
  id: "readme",
  name: "README Writer",
  description: "Draft docs",
  category: "docs",
  icon: "📝",
  accentColor: "#0ea5e9",
  template: "Write docs.",
  variables: [],
};

function baseProps() {
  return {
    open: true,
    availableSkills: [CODE_SKILL, DOCS_SKILL],
    selectedSkillIds: [] as string[],
    skillValues: {} as Record<string, Record<string, string>>,
    onToggleSkill: vi.fn(),
    onVarChange: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("LaunchSkillsPanel", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<LaunchSkillsPanel {...baseProps()} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("groups skills by category and toggles selection on tap", () => {
    const props = baseProps();
    render(<LaunchSkillsPanel {...props} />);

    // Category labels present.
    expect(screen.getByText("Code")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();

    const row = screen.getByRole("button", { name: /Lint Cleanup/ });
    expect(row).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(row);
    expect(props.onToggleSkill).toHaveBeenCalledWith("lint");
  });

  it("marks selected skills as pressed and shows their variable inputs", () => {
    const props = { ...baseProps(), selectedSkillIds: ["lint"] };
    render(<LaunchSkillsPanel {...props} />);

    expect(screen.getByRole("button", { name: /Lint Cleanup/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The selected skill's variable input is rendered in the config section.
    const input = screen.getByLabelText("Scope");
    fireEvent.change(input, { target: { value: "server/" } });
    expect(props.onVarChange).toHaveBeenCalledWith("lint", "scope", "server/");
  });

  it("shows 'no configuration needed' for a selected skill without variables", () => {
    render(<LaunchSkillsPanel {...baseProps()} selectedSkillIds={["readme"]} />);
    expect(screen.getByText("No configuration needed.")).toBeInTheDocument();
  });

  it("renders an empty state when the project has no skills", () => {
    render(<LaunchSkillsPanel {...baseProps()} availableSkills={[]} />);
    expect(screen.getByText(/No skills in this project's library yet\./)).toBeInTheDocument();
  });

  it("closes via the close button, the Done button, and the backdrop", () => {
    const props = baseProps();
    const { rerender } = render(<LaunchSkillsPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Close skills" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /^Done/ }));
    expect(props.onClose).toHaveBeenCalledTimes(2);

    // Backdrop click (the dialog element itself) also closes.
    rerender(<LaunchSkillsPanel {...props} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(props.onClose).toHaveBeenCalledTimes(3);
  });

  it("reflects the selected count in the Done button label", () => {
    render(<LaunchSkillsPanel {...baseProps()} selectedSkillIds={["lint", "readme"]} />);
    expect(screen.getByRole("button", { name: "Done (2)" })).toBeInTheDocument();
  });
});
