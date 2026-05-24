/**
 * Component test for SettingsMenu — the header-anchored settings popover.
 *
 * Behaviours covered:
 *   - The trigger button is rendered and the popover starts closed.
 *   - Clicking the trigger opens the popover.
 *   - Changing a select fires onSettingsChange with the merged settings.
 *   - Pressing Escape closes the popover.
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { HarnessListProvider } from "./use-harness-list.tsx";
import type { HarnessListEntry } from "./use-socket.ts";

const CLAUDE_ENTRY: HarnessListEntry = {
  name: "claude",
  capabilities: {
    thinking: true,
    promptCaching: true,
    mcp: true,
    permissionPrompts: true,
    resume: true,
    partialMessages: true,
    builtInFilesystem: true,
  },
  builtInTools: [],
  models: [
    { id: "claude-opus-4-7", label: "Opus 4.7" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  ],
  commands: [],
  agents: [],
  account: { provider: "claude" },
};

const CODEX_ENTRY: HarnessListEntry = {
  name: "codex",
  capabilities: {
    thinking: true,
    promptCaching: true,
    mcp: true,
    permissionPrompts: true,
    resume: true,
    partialMessages: false,
    builtInFilesystem: true,
  },
  builtInTools: [],
  models: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ],
  commands: [],
  agents: [],
  account: { provider: "openai" },
};

function renderWithHarnesses(
  entries: HarnessListEntry[],
  props: React.ComponentProps<typeof SettingsMenu>,
) {
  let subscriber: ((m: unknown) => void) | null = null;
  const send = vi.fn();
  const subscribe = (fn: (m: unknown) => void) => {
    subscriber = fn;
    return () => {
      subscriber = null;
    };
  };

  render(
    <HarnessListProvider send={send} subscribe={subscribe} connected={true}>
      <SettingsMenu {...props} />
    </HarnessListProvider>,
  );
  act(() => {
    subscriber?.({ type: "harness_list", harnesses: entries });
  });
}

describe("SettingsMenu", () => {
  it("starts closed and opens on trigger click", () => {
    render(<SettingsMenu settings={{}} onSettingsChange={() => {}} />);

    const trigger = screen.getByRole("button", { name: /open settings/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: /settings/i })).toBeNull();

    fireEvent.click(trigger);

    // getByRole throws if missing — the dialog is now open.
    screen.getByRole("dialog", { name: /settings/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("emits merged settings when permission mode changes", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{ defaultLeaderModel: "opus" }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    const dialog = screen.getByRole("dialog", { name: /settings/i });
    const selects = dialog.querySelectorAll("select");
    // Order in the popover: permission mode, leader model, minion model.
    const permissionSelect = selects[0]!;
    fireEvent.change(permissionSelect, { target: { value: "bypassPermissions" } });

    expect(onChange).toHaveBeenCalledWith({
      defaultLeaderModel: "opus",
      defaultPermissionMode: "bypassPermissions",
    });
  });

  it("stores harness and concrete model when leader model changes", () => {
    const onChange = vi.fn();
    renderWithHarnesses([CLAUDE_ENTRY, CODEX_ENTRY], {
      settings: { defaultLeaderHarness: "claude", defaultLeaderModel: "claude-opus-4-7" },
      onSettingsChange: onChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    const dialog = screen.getByRole("dialog", { name: /settings/i });
    const selects = dialog.querySelectorAll("select");
    const leaderModelSelect = selects[1]!;
    fireEvent.change(leaderModelSelect, { target: { value: "codex::gpt-5.5" } });

    expect(onChange).toHaveBeenCalledWith({
      defaultLeaderHarness: "codex",
      defaultLeaderModel: "gpt-5.5",
      defaultLeaderThinkingConfig: {
        enabled: true,
        effort: "high",
        display: "summarized",
      },
      defaultModel: "gpt-5.5",
    });
  });

  it("stores default reasoning settings for leader and minion models", () => {
    const onChange = vi.fn();
    renderWithHarnesses([CLAUDE_ENTRY, CODEX_ENTRY], {
      settings: {
        defaultLeaderHarness: "claude",
        defaultLeaderModel: "claude-opus-4-7",
        defaultLeaderThinkingConfig: {
          enabled: true,
          effort: "high",
          display: "summarized",
        },
        defaultMinionHarness: "codex",
        defaultMinionModel: "gpt-5.5",
        defaultMinionThinkingConfig: {
          enabled: true,
          effort: "medium",
          display: "summarized",
        },
      },
      onSettingsChange: onChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    fireEvent.click(screen.getAllByRole("button", { name: "XHigh" })[0]!);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultLeaderThinkingConfig: {
          enabled: true,
          effort: "xhigh",
          display: "summarized",
        },
      }),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Hidden" })[1]!);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultMinionThinkingConfig: {
          enabled: true,
          effort: "medium",
          display: "omitted",
        },
      }),
    );
  });

  it("stores dashboard context action names and prompt defaults", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{
          dashboardLeaderActionNames: { improve: "Improve label" },
          dashboardLeaderActionPrompts: { improve: "Improve old" },
        }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    fireEvent.change(screen.getByDisplayValue("Improve label"), {
      target: { value: "Polish" },
    });

    expect(onChange).toHaveBeenCalledWith({
      dashboardLeaderActionNames: { improve: "Polish" },
      dashboardLeaderActionPrompts: { improve: "Improve old" },
    });

    fireEvent.change(screen.getByDisplayValue("Improve old"), {
      target: { value: "Improve new" },
    });

    expect(onChange).toHaveBeenCalledWith({
      dashboardLeaderActionNames: { improve: "Improve label" },
      dashboardLeaderActionPrompts: { improve: "Improve new" },
    });
  });

  it("closes on Escape", () => {
    render(<SettingsMenu settings={{}} onSettingsChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    // Throws if missing — confirms popover is open before we test the close.
    screen.getByRole("dialog", { name: /settings/i });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: /settings/i })).toBeNull();
  });
});
