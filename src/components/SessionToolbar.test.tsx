/**
 * SessionToolbar — Phase E behaviour.
 *
 * Covers the harness-aware controls added in `docs/codex-harness-spec.md`
 * Phase E:
 *   - Model picker combines harness, model, and reasoning controls.
 *   - Model picker can switch harness+model together before a session exists.
 *   - Model picker shows every harness after a session exists, with only the
 *     fixed session harness selectable (mid-session swap is intentionally
 *     unsupported).
 *   - Permission selector is hidden for harnesses with no permission concept.
 *   - "plan" permission mode is dropped for the Codex harness.
 *   - Thinking controls disappear when the harness disables thinking.
 *   - Codex models surface only when the active harness is Codex.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SessionToolbar } from "./SessionToolbar.tsx";
import { HarnessListProvider } from "../use-harness-list.tsx";
import type { ThinkingConfig } from "../types.ts";
import type { HarnessListEntry } from "../use-socket.ts";

// ── Test helpers ───────────────────────────────────────────────

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
  builtInTools: ["Read", "Bash"],
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
  ],
  commands: [],
  agents: [],
  account: { provider: "openai" },
};

const ECHO_ENTRY: HarnessListEntry = {
  name: "echo",
  capabilities: {
    thinking: false,
    promptCaching: false,
    mcp: false,
    permissionPrompts: false,
    resume: false,
    partialMessages: false,
    builtInFilesystem: false,
  },
  builtInTools: [],
  models: [{ id: "echo", label: "Echo" }],
  commands: [],
  agents: [],
  account: { provider: "echo" },
};

const DEFAULT_THINKING: ThinkingConfig = {
  enabled: true,
  effort: "high",
  display: "summarized",
};

function renderWithHarnesses(
  entries: HarnessListEntry[],
  overrides: Partial<React.ComponentProps<typeof SessionToolbar>> = {},
): React.ComponentProps<typeof SessionToolbar> {
  // Capture the subscriber the provider registers on mount, then deliver
  // the `harness_list` payload from the test in an `act()` wrapper after
  // first render so the provider state reflects the inventory before any
  // assertions run.
  let subscriber: ((m: unknown) => void) | null = null;
  const send = vi.fn();
  const subscribe = (fn: (m: unknown) => void) => {
    subscriber = fn;
    return () => {
      subscriber = null;
    };
  };

  const baseProps: React.ComponentProps<typeof SessionToolbar> = {
    sessionKey: null,
    status: "disconnected",
    model: "claude-sonnet-4-6",
    permissionMode: "auto",
    onInterrupt: vi.fn(),
    onModelChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    thinkingConfig: DEFAULT_THINKING,
    onThinkingConfigChange: vi.fn(),
    harness: "claude",
    onHarnessChange: vi.fn(),
    ...overrides,
  };

  render(
    <HarnessListProvider send={send} subscribe={subscribe} connected={true}>
      <SessionToolbar {...baseProps} />
    </HarnessListProvider>,
  );
  act(() => {
    subscriber?.({ type: "harness_list", harnesses: entries });
  });
  return baseProps;
}

// ── Tests ──────────────────────────────────────────────────────

describe("SessionToolbar — model selection picker", () => {
  it("combines harness, model, and reasoning into one trigger", () => {
    renderWithHarnesses([CLAUDE_ENTRY]);
    expect(screen.getByTitle("Model selection")).toHaveTextContent("Anthropic");
    expect(screen.getByTitle("Model selection")).toHaveTextContent("Sonnet 4.6");
    expect(screen.getByTitle("Model selection")).toHaveTextContent("Balanced");
    expect(screen.getByTitle("Model selection")).toHaveTextContent("High");
  });

  it("switches harness and model together before a session exists", () => {
    const props = renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    fireEvent.click(screen.getByRole("button", { name: /GPT-5.5/ }));
    expect(props.onHarnessChange).toHaveBeenCalledWith("codex", "gpt-5.5");
  });

  it("changes only the model when the selected model belongs to the active harness", () => {
    const props = renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude", model: "claude-sonnet-4-6" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    fireEvent.click(screen.getByRole("button", { name: /Opus 4.7/ }));
    expect(props.onModelChange).toHaveBeenCalledWith("claude-opus-4-7");
    expect(props.onHarnessChange).not.toHaveBeenCalled();
  });

  it("does not add vague tier chips to model rows", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude", model: "claude-sonnet-4-6" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));

    expect(screen.getByRole("button", { name: /Opus 4.7/ })).not.toHaveTextContent("Frontier");
    expect(screen.getByRole("button", { name: /GPT-5.5/ })).not.toHaveTextContent("General");
  });

  it("shows but disables inactive harnesses after a session exists", () => {
    const props = renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: "leader-1", harness: "claude" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(props.onHarnessChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /GPT-5.5/ })).toBeDisabled();
    expect(screen.getByText("fixed for session")).toBeInTheDocument();
  });

  it("closes when clicking outside even if the outside surface stops propagation", () => {
    render(
      <div>
        <HarnessListProvider send={vi.fn()} subscribe={() => vi.fn()} connected={true}>
          <SessionToolbar
            sessionKey={null}
            status="disconnected"
            model="claude-sonnet-4-6"
            permissionMode="auto"
            onInterrupt={vi.fn()}
            onModelChange={vi.fn()}
            onPermissionModeChange={vi.fn()}
            thinkingConfig={DEFAULT_THINKING}
            onThinkingConfigChange={vi.fn()}
            harness="claude"
            onHarnessChange={vi.fn()}
          />
        </HarnessListProvider>
        <div data-testid="chat-window" onMouseDown={(e) => e.stopPropagation()} />
      </div>,
    );

    fireEvent.click(screen.getByTitle("Model selection"));
    expect(screen.getByText("Reasoning")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("chat-window"));
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    renderWithHarnesses([CLAUDE_ENTRY]);
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(screen.getByText("Reasoning")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });
});

describe("SessionToolbar — capability gating", () => {
  it("hides the permission selector when the harness has no permission concept", () => {
    renderWithHarnesses(
      [ECHO_ENTRY, CLAUDE_ENTRY],
      { harness: "echo", model: "echo", permissionMode: "auto" },
    );
    // Permission labels are unique strings — none should render for Echo.
    expect(screen.queryByText("Auto-approve safe operations")).not.toBeInTheDocument();
    expect(screen.queryByText("Bypass")).not.toBeInTheDocument();
  });

  it("hides the 'plan' permission option for the Codex harness", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { harness: "codex", model: "gpt-5.5", permissionMode: "auto" },
    );
    const trigger = screen.getByText("Auto");
    fireEvent.click(trigger);
    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("Bypass")).toBeInTheDocument();
  });

  it("hides thinking controls when the harness disables thinking", () => {
    renderWithHarnesses(
      [ECHO_ENTRY, CLAUDE_ENTRY],
      { harness: "echo", model: "echo" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
    expect(screen.queryByText("Summaries")).not.toBeInTheDocument();
  });
});

describe("SessionToolbar — harness-aware models", () => {
  it("keeps Codex models selectable only when the active harness is Codex", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: "leader-1", harness: "codex", model: "gpt-5.5", permissionMode: "auto" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(screen.getAllByText("GPT-5.5").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /GPT-5.4/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Sonnet 4.6/ })).toBeDisabled();
  });

  it("keeps Claude models selectable only when the active harness is Claude", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: "leader-1", harness: "claude", model: "claude-opus-4-7" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(screen.getByRole("button", { name: /Sonnet 4.6/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /GPT-5.5/ })).toBeDisabled();
  });

  it("keeps reasoning controls inside the model picker", () => {
    const props = renderWithHarnesses([CLAUDE_ENTRY]);
    fireEvent.click(screen.getByTitle("Model selection"));
    fireEvent.click(screen.getByRole("button", { name: "Low" }));
    expect(props.onThinkingConfigChange).toHaveBeenCalledWith({
      ...DEFAULT_THINKING,
      effort: "low",
    });
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    expect(props.onThinkingConfigChange).toHaveBeenCalledWith({
      ...DEFAULT_THINKING,
      display: "omitted",
    });
  });
});
