import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SessionToolbar } from "./SessionToolbar.tsx";
import { HarnessListProvider } from "../use-harness-list.tsx";
import type { ThinkingConfig } from "../types.ts";
import type { HarnessListEntry } from "../use-socket.ts";

const CLAUDE_ENTRY: HarnessListEntry = {
  name: "claude",
  capabilities: {
    mutationInterception: "complete",
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
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-opus-4-7", label: "Opus 4.7" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
  ],
  commands: [],
  agents: [],
  account: { provider: "claude" },
};

const CODEX_ENTRY: HarnessListEntry = {
  name: "codex",
  capabilities: {
    mutationInterception: "observe_only",
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
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  ],
  commands: [],
  agents: [],
  account: { provider: "openai" },
};

const ECHO_ENTRY: HarnessListEntry = {
  name: "echo",
  capabilities: {
    mutationInterception: "none",
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
  overrides: {
    [K in keyof React.ComponentProps<typeof SessionToolbar>]?:
      | React.ComponentProps<typeof SessionToolbar>[K]
      | undefined;
  } = {},
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
    model: "claude-sonnet-5",
    permissionMode: "auto",
    onInterrupt: vi.fn(),
    onModelChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    thinkingConfig: DEFAULT_THINKING,
    onThinkingConfigChange: vi.fn(),
    harness: "claude",
    onHarnessChange: vi.fn(),
  };
  Object.assign(baseProps, overrides);
  // An explicit `undefined` override means "omit this optional prop" — under
  // exactOptionalPropertyTypes the property must be absent, not undefined.
  if ("onInterrupt" in overrides && overrides.onInterrupt === undefined) {
    delete (baseProps as { onInterrupt?: () => void }).onInterrupt;
  }

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
  it("combines harness, model, and reasoning into one trigger without tier chips", () => {
    renderWithHarnesses([CLAUDE_ENTRY]);
    expect(screen.getByTitle("Model selection")).toHaveTextContent("Anthropic");
    expect(screen.getByTitle("Model selection")).toHaveTextContent("Sonnet 5");
    expect(screen.getByTitle("Model selection")).not.toHaveTextContent("Balanced");
    expect(screen.getByTitle("Model selection")).toHaveTextContent("High");
  });

  it("lists providers with OpenAI first", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY, ECHO_ENTRY],
      { sessionKey: null, harness: "claude" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining("OpenAI"),
      expect.stringContaining("Anthropic"),
      expect.stringContaining("Echo"),
    ]);
  });

  it("selecting a provider commits its harness and default model", () => {
    const props = renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    // The OpenAI provider's default is its first model (GPT-5.6 Sol in the fixture).
    fireEvent.click(screen.getByRole("tab", { name: /OpenAI/ }));
    expect(props.onHarnessChange).toHaveBeenCalledWith("codex", "gpt-5.6-sol");
  });

  it("scopes the model list to the active provider", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude", model: "claude-sonnet-5" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    // Active provider is Anthropic, so only Claude models are listed.
    expect(screen.getByRole("button", { name: /Opus 4.8/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /GPT-5.5/ })).not.toBeInTheDocument();
  });

  it("changes only the model when the selected model belongs to the active harness", () => {
    const props = renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude", model: "claude-sonnet-5" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    fireEvent.click(screen.getByRole("button", { name: /Opus 4.8/ }));
    expect(props.onModelChange).toHaveBeenCalledWith("claude-opus-4-8");
    expect(props.onHarnessChange).not.toHaveBeenCalled();
  });

  it("offers Fable 5 as a Claude model", () => {
    const props = renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude", model: "claude-sonnet-5" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    const fableOption = screen.getByRole("button", { name: /Fable 5/ });
    fireEvent.click(fableOption);
    expect(props.onModelChange).toHaveBeenCalledWith("claude-fable-5");
  });

  it("does not add vague tier chips to model rows", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: null, harness: "claude", model: "claude-sonnet-5" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));

    expect(screen.getByRole("button", { name: /Opus 4.8/ })).not.toHaveTextContent("Frontier");
    expect(screen.getByRole("button", { name: /Opus 4.7/ })).not.toHaveTextContent("General");
  });

  it("locks the provider to the active harness after a session exists", () => {
    const props = renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: "leader-1", harness: "claude" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(props.onHarnessChange).not.toHaveBeenCalled();
    // The active provider tab stays enabled; other providers are locked.
    expect(screen.getByRole("tab", { name: /Anthropic/ })).toBeEnabled();
    expect(screen.getByRole("tab", { name: /OpenAI/ })).toBeDisabled();
    expect(screen.getByText("fixed for session")).toBeInTheDocument();
  });

  it("closes when clicking outside even if the outside surface stops propagation", () => {
    render(
      <div>
        <HarnessListProvider send={vi.fn()} subscribe={() => vi.fn()} connected={true}>
          <SessionToolbar
            sessionKey={null}
            status="disconnected"
            model="claude-sonnet-5"
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

  it("offers the 'plan' permission option for the Codex harness", () => {
    // Codex honors plan mode via a read-only sandbox, so it is a valid choice.
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { harness: "codex", model: "gpt-5.5", permissionMode: "auto" },
    );
    const trigger = screen.getByText("Auto");
    fireEvent.click(trigger);
    expect(screen.getByText("Plan")).toBeInTheDocument();
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

  it("renders the interrupt button on a running session when onInterrupt is provided", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY],
      { sessionKey: "leader-1", status: "running", onInterrupt: vi.fn() },
    );
    expect(screen.getByText("Interrupt")).toBeInTheDocument();
  });

  it("omits the interrupt button when onInterrupt is not provided", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY],
      { sessionKey: "leader-1", status: "running", onInterrupt: undefined },
    );
    expect(screen.queryByText("Interrupt")).not.toBeInTheDocument();
  });
});

describe("SessionToolbar — harness-aware models", () => {
  it("lists only Codex models when the active harness is Codex", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: "leader-1", harness: "codex", model: "gpt-5.5", permissionMode: "auto" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(screen.getByRole("button", { name: /GPT-5.4/ })).toBeEnabled();
    // Claude models aren't in the list; the Anthropic provider tab is locked.
    expect(screen.queryByRole("button", { name: /Sonnet 5/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Anthropic/ })).toBeDisabled();
  });

  it("lists only Claude models when the active harness is Claude", () => {
    renderWithHarnesses(
      [CLAUDE_ENTRY, CODEX_ENTRY],
      { sessionKey: "leader-1", harness: "claude", model: "claude-opus-4-8" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    expect(screen.getByRole("button", { name: /Sonnet 5/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /GPT-5.5/ })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /OpenAI/ })).toBeDisabled();
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

  it("offers documented xhigh reasoning for GPT-5.6 Sol", () => {
    const props = renderWithHarnesses(
      [CODEX_ENTRY],
      { harness: "codex", model: "gpt-5.6-sol" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    fireEvent.click(screen.getByRole("button", { name: "XHigh" }));
    expect(props.onThinkingConfigChange).toHaveBeenCalledWith({
      ...DEFAULT_THINKING,
      effort: "xhigh",
    });
  });

  it("offers documented max reasoning for GPT-5.6 Sol", () => {
    const props = renderWithHarnesses(
      [CODEX_ENTRY],
      { harness: "codex", model: "gpt-5.6-sol" },
    );
    fireEvent.click(screen.getByTitle("Model selection"));
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(props.onThinkingConfigChange).toHaveBeenCalledWith({
      ...DEFAULT_THINKING,
      effort: "max",
    });
  });
});
