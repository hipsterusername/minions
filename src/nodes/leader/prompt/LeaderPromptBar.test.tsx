import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  LeaderPromptBar,
  LeaderSlashCommandsProvider,
} from "./LeaderPromptBar.tsx";
import { buildSlashCommands, type SlashCommand } from "./slash-commands.ts";

const slashCommands = buildSlashCommands(undefined);

function renderPromptBar({
  initialInput = "",
  commands = slashCommands,
  onInputChange = vi.fn(),
  onKeyDown = vi.fn(),
  onSubmit = vi.fn(),
}: {
  initialInput?: string;
  commands?: SlashCommand[] | null;
  onInputChange?: ComponentProps<typeof LeaderPromptBar>["onInputChange"];
  onKeyDown?: ComponentProps<typeof LeaderPromptBar>["onKeyDown"];
  onSubmit?: ComponentProps<typeof LeaderPromptBar>["onSubmit"];
} = {}) {
  function Harness() {
    const [input, setInput] = useState(initialInput);
    return (
      <LeaderPromptBar
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
    );
  }

  render(<Harness />);
  return { onInputChange, onKeyDown, onSubmit };
}

describe("LeaderPromptBar slash commands", () => {
  it("shows context shortcuts and Graph for a slash", () => {
    renderPromptBar({ initialInput: "/" });

    expect(screen.getAllByRole("option")).toHaveLength(4);
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
