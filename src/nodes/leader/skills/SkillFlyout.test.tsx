import { createRef } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillTemplate } from "../../../skills/types.ts";
import { SkillFlyout } from "./SkillFlyout.tsx";

const skills: SkillTemplate[] = [
  {
    id: "code-review",
    name: "Code Review",
    description: "Review a change for correctness and maintainability.",
    category: "code",
    icon: "🔎",
    accentColor: "#7c9cff",
    template: "Review {{focus}} with {{depth}} depth.",
    variables: [
      {
        name: "focus",
        label: "Review focus",
        type: "textarea",
        required: true,
        placeholder: "Security, performance, or API design",
        description: "The concerns that deserve extra attention.",
      },
      {
        name: "depth",
        label: "Review depth",
        type: "select",
        defaultValue: "standard",
        options: [
          { value: "standard", label: "Standard" },
          { value: "deep", label: "Deep" },
        ],
      },
    ],
  },
  {
    id: "release-check",
    name: "Release Check",
    description: "Audit release readiness and deployment risks.",
    category: "devops",
    icon: "🚀",
    accentColor: "#53b98c",
    template: "Check the release.",
    variables: [],
  },
];

vi.mock("../../../skills/registry.ts", () => ({
  getPickableSkills: () => skills,
  getSkill: (id: string) => skills.find((skill) => skill.id === id),
}));

type SkillUpdate = {
  skillIds?: string[];
  skillValues?: Record<string, Record<string, string>>;
  skillPanelOpen?: boolean;
};

function renderFlyout({
  skillIds = [],
  skillValues = {},
  readOnly = false,
  onUpdate = vi.fn(),
  onClose = vi.fn(),
}: {
  skillIds?: string[];
  skillValues?: Record<string, Record<string, string>>;
  readOnly?: boolean;
  onUpdate?: (patch: SkillUpdate) => void;
  onClose?: () => void;
} = {}) {
  const anchor = document.createElement("button");
  anchor.dataset["testAnchor"] = "true";
  document.body.append(anchor);
  const anchorRef = createRef<HTMLButtonElement>();
  anchorRef.current = anchor;
  const result = render(
    <SkillFlyout
      skillIds={skillIds}
      skillValues={skillValues}
      open
      readOnly={readOnly}
      anchorRef={anchorRef}
      onUpdate={onUpdate}
      onClose={onClose}
    />,
  );
  return { ...result, anchor, anchorRef, onUpdate, onClose };
}

describe("SkillFlyout", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1100,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
  });

  afterEach(() => {
    document
      .querySelectorAll("[data-test-anchor]")
      .forEach((anchor) => anchor.remove());
  });

  it("makes searching, adding, and removing skills explicit", async () => {
    const onUpdate = vi.fn();
    renderFlyout({ skillIds: ["code-review"], onUpdate });

    expect(screen.getByRole("dialog", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Code Review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Release Check" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Release Check" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      skillIds: ["code-review", "release-check"],
      skillPanelOpen: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove Code Review" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      skillIds: [],
      skillValues: {},
    });

    const search = screen.getByRole("searchbox", { name: "Search skills" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "release" } });
    const browser = screen.getByRole("region", { name: "Browse skills" });
    expect(within(browser).queryByText("Code Review")).not.toBeInTheDocument();
    expect(within(browser).getByText("Release Check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear skill search" })).toHaveAttribute(
      "title",
      "Clear search",
    );
  });

  it("keeps variable labels, help text, and updates accessible", () => {
    const onUpdate = vi.fn();
    renderFlyout({
      skillIds: ["code-review"],
      skillValues: { "code-review": { focus: "API design" } },
      onUpdate,
    });

    const focus = screen.getByRole("textbox", { name: /review focus/i });
    expect(focus).toHaveValue("API design");
    expect(focus).toHaveAccessibleDescription(
      "The concerns that deserve extra attention.",
    );
    expect(focus).toHaveAttribute("aria-required", "true");

    fireEvent.change(focus, { target: { value: "Authentication" } });
    expect(onUpdate).toHaveBeenCalledWith({
      skillValues: {
        "code-review": { focus: "Authentication" },
      },
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Review depth" }), {
      target: { value: "deep" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      skillValues: {
        "code-review": { focus: "API design", depth: "deep" },
      },
    });
  });

  it("closes on Escape and restores focus to the anchor", async () => {
    const onClose = vi.fn();
    const view = renderFlyout({ onClose });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(
      <SkillFlyout
        skillIds={[]}
        skillValues={{}}
        open={false}
        readOnly={false}
        anchorRef={view.anchorRef}
        onUpdate={view.onUpdate}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(view.anchor).toHaveFocus());
  });

  it("uses browse and configure tabs at compact canvas widths", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 420,
    });
    renderFlyout({ skillIds: ["code-review"] });

    const browseTab = screen.getByRole("tab", { name: "Browse" });
    const configureTab = screen.getByRole("tab", { name: /Configure/ });
    expect(browseTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("region", { name: "Configure selected skills", hidden: true }),
    ).toHaveAttribute("data-hidden", "true");

    fireEvent.click(configureTab);
    expect(configureTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("region", { name: "Browse skills", hidden: true }),
    ).toHaveAttribute("data-hidden", "true");
    expect(screen.getByRole("textbox", { name: /review focus/i })).toBeInTheDocument();
  });

  it("keeps read-only skills visible without editable actions", () => {
    renderFlyout({ skillIds: ["release-check"], readOnly: true });

    const browser = screen.getByRole("region", { name: "Browse skills" });
    expect(within(browser).getByText("Release Check")).toBeInTheDocument();
    expect(within(browser).getByText("Selected")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Release Check" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/no configuration needed/i)).toBeInTheDocument();
  });
});
