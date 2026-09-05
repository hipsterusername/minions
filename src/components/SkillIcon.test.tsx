import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkillIcon } from "./SkillIcon.tsx";

describe("SkillIcon", () => {
  it("renders legacy artwork consistently without changing saved badges", () => {
    const skill = Object.freeze({ icon: "🎨", category: "general" as const });
    const { container } = render(<button><SkillIcon skill={skill} /> Design</button>);
    expect(container.querySelector('svg[data-minions-icon="appearance"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Design" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("🎨");
    expect(skill.icon).toBe("🎨");
  });

  it.each(["⚙", "⚙️", "⚙︎"])("handles presentation selectors in %s", (icon) => {
    const { container } = render(<SkillIcon skill={{ icon, category: "general" }} />);
    expect(container.querySelector('svg[data-minions-icon="settings"]')).toBeInTheDocument();
  });

  it.each(["🦊", "🇨🇦", "1️⃣", ""])("uses category artwork for an unmapped badge %s", (icon) => {
    const { container } = render(<SkillIcon skill={{ icon, category: "testing" }} />);
    expect(container.querySelector('svg[data-minions-icon="testing"]')).toBeInTheDocument();
  });

  it.each(["SM", "SB", "λ", "#", "1", "constructor", "__proto__"])("preserves a custom text badge %s", (icon) => {
    const { container } = render(<SkillIcon skill={{ icon, category: "general" }} />);
    expect(container).toHaveTextContent(icon);
    expect(container.querySelector("svg")).toBeNull();
  });
});

it("renders a saved library ID and falls back for unknown IDs", () => {
  const { container, rerender } = render(<SkillIcon skill={{ icon: "minions:rocket", category: "code" }} size={24} />);
  expect(container.querySelector('svg[data-minions-icon="rocket"]')).toHaveAttribute("width", "24");
  rerender(<SkillIcon skill={{ icon: "minions:future-icon", category: "code" }} />);
  expect(container.querySelector('svg[data-minions-icon="code"]')).toBeInTheDocument();
  expect(container.textContent).not.toContain("minions:");
});
