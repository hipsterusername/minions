import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  LeaderPromptBar,
  LeaderSlashCommandsProvider,
} from "./LeaderPromptBar.tsx";
import { buildSlashCommands, type SlashCommand } from "./slash-commands.ts";
import { LeaderPromptSkillsContext } from "./LeaderPromptSkillsContext.ts";
import { getSkill, registerSkill, unregisterSkill } from "../../../skills/registry.ts";

const slashCommands = buildSlashCommands(undefined);

function renderPromptBar({
  initialInput = "",
  commands = slashCommands,
  onInputChange = vi.fn(),
  onKeyDown = vi.fn(),
  onSubmit = vi.fn(),
  onSkillSelect,
  variant = "inline",
  portalSlashMenu = false,
}: {
  initialInput?: string;
  commands?: SlashCommand[] | null;
  onInputChange?: ComponentProps<typeof LeaderPromptBar>["onInputChange"];
  onKeyDown?: ComponentProps<typeof LeaderPromptBar>["onKeyDown"];
  onSubmit?: ComponentProps<typeof LeaderPromptBar>["onSubmit"];
  onSkillSelect?: (id: string) => void;
  variant?: "inline" | "overlay";
  portalSlashMenu?: boolean;
} = {}) {
  function Harness() {
    const [input, setInput] = useState(initialInput);
    return (
      <LeaderPromptSkillsContext.Provider value={onSkillSelect}>
        <LeaderPromptBar
          variant={variant}
          portalSlashMenu={portalSlashMenu}
          input={input}
          onInputChange={(value) => {
            onInputChange(value);
            setInput(value);
          }}
          onKeyDown={onKeyDown}
          onSubmit={onSubmit}
          placeholder="Prompt"
          submitLabel="Start"
          disabled={false}
          active
          {...(commands === null ? {} : { slashCommands: commands })}
        />
      </LeaderPromptSkillsContext.Provider>
    );
  }

  render(<Harness />);
  return { onInputChange, onKeyDown, onSubmit };
}

describe("LeaderPromptBar skill mentions", () => {
  it("includes project skills in the picker", () => {
    registerSkill({ ...getSkill("skill-builder")!, id: "project-check", name: "Project Check" });
    try {
      const onSkillSelect = vi.fn();
      renderPromptBar({ initialInput: "Check this\n@project", onSkillSelect });
      fireEvent.click(screen.getByRole("option", { name: /Project Check/ }));
      expect(onSkillSelect).toHaveBeenCalledExactlyOnceWith("project-check");
      expect(screen.getByLabelText("Leader prompt")).toHaveValue("Check this\n@project-check ");
    } finally {
      unregisterSkill("project-check");
    }
  });

  it.each(["inline", "overlay"] as const)("selects a skill with Enter in the %s composer without submitting", (variant) => {
    const onSkillSelect = vi.fn();
    const { onKeyDown, onSubmit } = renderPromptBar({
      initialInput: "Use @skill-b", onSkillSelect, variant, portalSlashMenu: variant === "overlay",
    });
    const textarea = screen.getByRole("combobox", { name: "Leader prompt" }) as HTMLTextAreaElement;
    expect(screen.getByRole("listbox", { name: "Leader skills" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea).toHaveValue("Use @skill-builder ");
    expect(textarea).toHaveFocus();
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(onSkillSelect).toHaveBeenCalledExactlyOnceWith("skill-builder");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("filters by display name and selects by clicking", () => {
    const onSkillSelect = vi.fn();
    renderPromptBar({ initialInput: "@Builder", onSkillSelect });
    fireEvent.click(screen.getByRole("option", { name: /Skill Builder/ }));
    expect(onSkillSelect).toHaveBeenCalledExactlyOnceWith("skill-builder");
    expect(screen.getByLabelText("Leader prompt")).toHaveValue("@skill-builder ");
  });

  it("replaces the whole token at the caret while preserving surrounding text", () => {
    const onSkillSelect = vi.fn();
    renderPromptBar({ initialInput: "Use @skill-bad for this task", onSkillSelect });
    const textarea = screen.getByLabelText("Leader prompt") as HTMLTextAreaElement;
    textarea.setSelectionRange(12, 12);
    fireEvent.select(textarea);
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea).toHaveValue("Use @skill-builder for this task");
    expect(textarea.selectionStart).toBe("Use @skill-builder ".length);
    expect(onSkillSelect).toHaveBeenCalledExactlyOnceWith("skill-builder");
  });

  it("supports arrow navigation and Escape dismissal", () => {
    const onSkillSelect = vi.fn();
    renderPromptBar({ initialInput: "@", onSkillSelect });
    const textarea = screen.getByLabelText("Leader prompt");
    const options = screen.getAllByRole("option");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveAttribute("aria-activedescendant", options[1]!.id);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(textarea).toHaveValue("@");
    expect(onSkillSelect).not.toHaveBeenCalled();
  });

  it.each(["hello@example.com", "@nonexistent-skill", "already @skill-builder done"])("keeps normal prompt handling for %s", (initialInput) => {
    const { onKeyDown } = renderPromptBar({ initialInput, onSkillSelect: vi.fn() });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Leader prompt"), { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});

describe("LeaderPromptBar slash commands", () => {
  it("shows context shortcuts, Graph, and Ship for a slash", () => {
    renderPromptBar({ initialInput: "/" });

    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByText("Ship")).toBeInTheDocument();
    expect(screen.getByText("Graph")).toBeInTheDocument();
    expect(screen.getByText("Implement")).toBeInTheDocument();
    expect(screen.getByText("Fix")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    const composer = screen.getByRole("combobox", { name: "Leader prompt" });
    const listbox = screen.getByRole("listbox");
    expect(composer).toHaveAttribute("aria-expanded", "true");
    expect(composer).toHaveAttribute("aria-controls", listbox.id);
    expect(composer).toHaveAttribute("aria-activedescendant",
      screen.getAllByRole("option")[0]?.id);
  });

  it("filters context shortcuts by display name", () => {
    renderPromptBar({ initialInput: "/rev" });

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Review/ })).toBeInTheDocument();
  });

  it("inserts the Ship review workflow without submitting it", () => {
    const { onSubmit, onKeyDown } = renderPromptBar({ initialInput: "/ship" });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByLabelText("Leader prompt"), { key: "Enter" });
    expect(screen.getByLabelText("Leader prompt")).toHaveValue(
      slashCommands.find(({ id }) => id === "ship")!.insertText,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it.each(["/graph", "/crew"])("invokes Graph from %s with Enter", (input) => {
    const { onSubmit } = renderPromptBar({ initialInput: input });
    const command = slashCommands.find(({ id }) => id === "task-graph")!;
    const option = screen.getByRole("option", { name: /Graph/ });
    expect(option.querySelector(".crew-icon")).not.toBeNull();
    const composer = screen.getByLabelText("Leader prompt");
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer).toHaveValue(command.insertText);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inserts the highlighted prompt on ArrowDown and Enter without submitting", () => {
    const onInputChange = vi.fn();
    const onKeyDown = vi.fn();
    const onSubmit = vi.fn();
    renderPromptBar({
      initialInput: "/",
      onInputChange,
      onKeyDown,
      onSubmit,
    });
    const textarea = screen.getByLabelText("Leader prompt") as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onInputChange).toHaveBeenCalledWith(slashCommands[1]?.insertText);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue(slashCommands[1]?.insertText);
    expect(textarea.selectionStart).toBe(slashCommands[1]?.insertText.length);
  });

  it("dismisses the menu on Escape without submitting or clearing input", () => {
    const onInputChange = vi.fn();
    const onKeyDown = vi.fn();
    const onSubmit = vi.fn();
    renderPromptBar({
      initialInput: "/",
      onInputChange,
      onKeyDown,
      onSubmit,
    });
    const textarea = screen.getByLabelText("Leader prompt");

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(textarea).toHaveValue("/");
    expect(onInputChange).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("preserves Enter handling when slash commands are absent", () => {
    const onKeyDown = vi.fn();
    const onSubmit = vi.fn();
    renderPromptBar({
      initialInput: "/",
      commands: null,
      onKeyDown,
      onSubmit,
    });
    const textarea = screen.getByLabelText("Leader prompt");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inherits commands from the Leader provider and inserts a clicked prompt", () => {
    const onInputChange = vi.fn();
    function Harness() {
      const [input, setInput] = useState("/");
      return (
        <LeaderSlashCommandsProvider commands={slashCommands}>
          <LeaderPromptBar
            input={input}
            onInputChange={(value) => {
              onInputChange(value);
              setInput(value);
            }}
            onKeyDown={() => {}}
            onSubmit={() => {}}
            placeholder="Prompt"
            submitLabel="Start"
            disabled={false}
            active
            variant="overlay"
          />
        </LeaderSlashCommandsProvider>
      );
    }
    render(<Harness />);
    const textarea = screen.getByLabelText("Leader prompt") as HTMLTextAreaElement;

    fireEvent.click(screen.getByTestId("leader-slash-command-analyze"));

    expect(onInputChange).toHaveBeenCalledWith(slashCommands[2]?.insertText);
    expect(textarea).toHaveValue(slashCommands[2]?.insertText);
    expect(textarea).toHaveFocus();
  });
});
