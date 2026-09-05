import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkillIconPicker } from "./SkillIconPicker.tsx";
import { isMinionsIconName } from "./MinionsIcon.tsx";
import { SKILL_ICON_LIBRARY } from "../skills/icon-library.ts";

function Picker() {
  const [value, setValue] = useState("minions:skill");
  return <SkillIconPicker value={value} onChange={setValue} category="general" accentColor="#3b82f6" />;
}

describe("SkillIconPicker", () => {
  it("ships over 100 unique icons with artwork", () => {
    expect(SKILL_ICON_LIBRARY.length).toBeGreaterThanOrEqual(100);
    expect(new Set(SKILL_ICON_LIBRARY.map((icon) => icon.name)).size).toBe(SKILL_ICON_LIBRARY.length);
    expect(SKILL_ICON_LIBRARY.every((icon) => isMinionsIconName(icon.name))).toBe(true);
  });

  it("searches purpose and name, selects an icon, and preserves selection through filtering", () => {
    render(<Picker />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search icons" }), { target: { value: "security" } });
    expect(screen.getByRole("button", { name: "Shield" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rocket" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Shield" }));
    expect(screen.getByRole("button", { name: "Shield" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no-such-icon" } });
    expect(screen.getByText("No icons found")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByRole("button", { name: "Shield" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("combobox", { name: "Icon category" }), { target: { value: "Design & media" } });
    expect(screen.getByRole("button", { name: "Palette" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Shield" })).not.toBeInTheDocument();
  });

  it("uses a single tab stop and arrow navigation in the gallery", () => {
    render(<Picker />);
    const gallery = screen.getByRole("group", { name: "Icon library" });
    const buttons = within(gallery).getAllByRole("button");
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    screen.getByRole("button", { name: "Skill hexagon" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Bot" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(buttons.at(-1)).toHaveFocus();
  });

  it("keeps custom text badges available", () => {
    render(<Picker />);
    fireEvent.click(screen.getByText("Use a custom text badge"));
    fireEvent.change(screen.getByLabelText("Letters or a symbol"), { target: { value: "UX" } });
    expect(screen.getByLabelText("Letters or a symbol")).toHaveValue("UX");
    expect(screen.getByText("UX")).toBeVisible();
  });
});
