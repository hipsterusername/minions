import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LeaderSlashMenu } from "./LeaderSlashMenu.tsx";
import type { SlashCommand } from "./slash-commands.ts";

const commands: SlashCommand[] = [
  {
    id: "improve",
    label: "Improve",
    description: "Improve the connected context.",
    insertText: "Full improve prompt",
  },
  {
    id: "analyze",
    label: "Analyze",
    description: "Analyze the connected context.",
    insertText: "Full analyze prompt",
  },
];

describe("LeaderSlashMenu", () => {
  it("renders an accessible highlighted option", () => {
    render(
      <LeaderSlashMenu
        commands={commands}
        selectedIndex={1}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );

    expect(screen.getByRole("listbox", { name: "Leader context shortcuts" })).toHaveAttribute(
      "data-no-drag",
    );
    expect(screen.getByRole("option", { name: /Analyze/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("reports hover and click selection without allowing mouse down to blur", () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    render(
      <LeaderSlashMenu
        commands={commands}
        selectedIndex={0}
        onSelect={onSelect}
        onHover={onHover}
      />,
    );
    const analyze = screen.getByTestId("leader-slash-command-analyze");
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

    fireEvent.mouseEnter(analyze);
    analyze.dispatchEvent(mouseDown);
    fireEvent.click(analyze);

    expect(onHover).toHaveBeenCalledWith(1);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(commands[1]);
  });

  it("shows a live match count and keyboard hints", () => {
    render(
      <LeaderSlashMenu
        commands={commands}
        selectedIndex={0}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );

    expect(screen.getByText("2 matches")).toBeInTheDocument();
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Select")).toBeInTheDocument();
    expect(screen.getByText("Esc to dismiss")).toBeInTheDocument();
  });

  it("uses the singular label for a single match", () => {
    render(
      <LeaderSlashMenu
        commands={[commands[0]!]}
        selectedIndex={0}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );

    expect(screen.getByText("1 match")).toBeInTheDocument();
  });

  it("highlights the matched portion of a command label", () => {
    render(
      <LeaderSlashMenu
        commands={commands}
        selectedIndex={0}
        onSelect={() => {}}
        onHover={() => {}}
        query="ana"
      />,
    );

    const mark = screen.getByText("Ana", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(mark.closest('[role="option"]')).toHaveAttribute(
      "data-testid",
      "leader-slash-command-analyze",
    );
  });
});
