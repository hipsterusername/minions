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
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { useState } from "react";
import { HarnessListProvider } from "./use-harness-list.tsx";
import type { HarnessListEntry, ServerMessage, SocketSubscribe } from "./use-socket.ts";
// The main Vitest project intentionally scans src/server/shared only. Import the
// colocated example contract so the copyable starter remains part of `pnpm verify`.
import "../examples/system-model-starter/starter.test.ts";

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
    sandboxEnforcement: { filesystem: [], approval: false },
  },
  builtInTools: [],
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
    sandboxEnforcement: {
      filesystem: ["read-only", "workspace-write", "unrestricted"],
      approval: true,
    },
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

function openCategory(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name, "i") }));
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

  it("organizes settings into focused categories", () => {
    render(<SettingsMenu settings={{}} onSettingsChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    const navigation = screen.getByRole("navigation", { name: /settings categories/i });
    expect(navigation).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /general/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("Labs")).toBeInTheDocument();
    expect(screen.getAllByText("Beta")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /operations/i })).toBeNull();
    expect(screen.queryByText("Session policy")).toBeNull();

    openCategory("Agent defaults");

    expect(screen.getByRole("heading", { name: "Agent defaults" })).toBeInTheDocument();
    expect(screen.getByText("Session policy")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Leader defaults" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Minion defaults" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
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
    openCategory("Agent defaults");

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

  it("saves execution sandbox defaults", () => {
    const onChange = vi.fn();
    render(<SettingsMenu settings={{}} onSettingsChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");
    fireEvent.change(screen.getByLabelText("Sandbox file access"), {
      target: { value: "read-only" },
    });

    expect(onChange).toHaveBeenCalledWith({
      defaultSandboxPolicy: {
        filesystemScope: "read-only",
        approvalPolicy: "on-failure",
      },
    });
  });

  it("shows unsupported defaults as unmanaged for the selected harness", () => {
    renderWithHarnesses([CLAUDE_ENTRY, CODEX_ENTRY], {
      settings: {
        defaultLeaderHarness: "claude",
        defaultLeaderModel: "claude-opus-4-8",
      },
      onSettingsChange: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");

    expect(screen.getByLabelText("Sandbox file access")).toHaveTextContent("Unmanaged by harness");
    expect(screen.getByLabelText("Sandbox approval policy")).toHaveTextContent("Unmanaged by harness");
  });

  it("emits merged settings when the system model mode changes", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{ defaultLeaderModel: "opus" }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Governance");

    const advisoryMode = screen.getByRole("radio", { name: /advisory/i });
    expect(screen.getByRole("radio", { name: /^off/i })).toBeChecked();
    fireEvent.click(advisoryMode);

    expect(onChange).toHaveBeenCalledWith({
      defaultLeaderModel: "opus",
      systemModel: "advisory",
    });
  });

  it("shows seeding guidance when the enabled system model has no manifest", () => {
    const socketSend = vi.fn();
    const subscribers: Array<(msg: ServerMessage) => void> = [];
    const socketSubscribe = vi.fn(
      (
        topicOrFn: string | ((msg: ServerMessage) => void),
        maybeFn?: (msg: ServerMessage) => void,
      ) => {
        const fn = typeof topicOrFn === "function" ? topicOrFn : maybeFn;
        if (fn) subscribers.push(fn);
        return () => {};
      },
    ) as unknown as SocketSubscribe;

    render(
      <SettingsMenu
        settings={{ systemModel: "advisory" }}
        onSettingsChange={() => {}}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Governance");
    expect(socketSend).toHaveBeenCalledWith({ type: "list_sessions" });

    act(() => {
      subscribers.forEach((fn) => fn({
        type: "session_list",
        sessions: [{ sessionKey: "leader-1", role: "leader" } as never],
      }));
    });
    const request = socketSend.mock.calls.find(
      ([payload]) => (payload as { type?: string }).type === "get_system_model_status",
    )?.[0] as { requestId: string };

    act(() => {
      subscribers.forEach((fn) => fn({
        type: "control_response",
        command: "get_system_model_status",
        sessionKey: "leader-1",
        requestId: request.requestId,
        success: true,
        status: {
          enabled: false,
          mode: "off",
          manifestFound: false,
          loadErrors: [],
        },
      }));
    });

    expect(screen.getByRole("status")).toHaveTextContent(/enabled but inactive/i);
  });

  it("tidy layout is on by default and toggles off to tidyLayout:false", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{ defaultLeaderModel: "opus" }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Workspace");

    const toggle = screen.getByRole("checkbox", { name: /tidy layout/i });
    // Absent setting → treated as on.
    expect((toggle as HTMLInputElement).checked).toBe(true);

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({
      defaultLeaderModel: "opus",
      tidyLayout: false,
    });
  });

  it("keeps the beta role system off by default and persists an opt-in", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{ defaultLeaderModel: "opus" }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");

    const toggle = screen.getByRole("checkbox", { name: /adaptive expert roles/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({
      defaultLeaderModel: "opus",
      roleSystemBeta: true,
    });
  });

  it("defaults new Leaders to Task Graph and exposes legacy planning as a debug toggle", () => {
    const onChange = vi.fn();
    render(<SettingsMenu settings={{}} onSettingsChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");

    const toggle = screen.getByRole("checkbox", { name: /use legacy planning tools/i });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Task Graph is the standard planner/i)).toBeVisible();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ leaderPlanningBackend: "legacy" });
  });

  it("uses a fixed Minion definition by default and reveals tier tabs only after opt-in", () => {
    const onChange = vi.fn();
    renderWithHarnesses([CLAUDE_ENTRY], {
      settings: {
        defaultMinionHarness: "claude",
        defaultMinionModel: "claude-sonnet-5",
        mechanicalMinionModel: "claude-fable-5",
        reasoningMinionModel: "claude-opus-4-8",
      },
      onSettingsChange: onChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");

    const toggle = screen.getByRole("checkbox", { name: /adaptive tier routing/i });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("tablist", { name: /minion assignment tiers/i })).toBeNull();
    expect(screen.getByRole("group", { name: "Fixed Minion model and reasoning" })).toBeVisible();

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      adaptiveMinionModelRouting: true,
      defaultMinionModel: "claude-sonnet-5",
      mechanicalMinionModel: "claude-fable-5",
      reasoningMinionModel: "claude-opus-4-8",
    }));
  });

  it("edits each adaptive Minion tier from a tabbed control", () => {
    const onChange = vi.fn();
    renderWithHarnesses([CLAUDE_ENTRY], {
      settings: {
        adaptiveMinionModelRouting: true,
        defaultMinionHarness: "claude",
        defaultMinionModel: "claude-sonnet-5",
        mechanicalMinionModel: "claude-fable-5",
        reasoningMinionModel: "claude-opus-4-8",
      },
      onSettingsChange: onChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");

    const tabs = screen.getByRole("tablist", { name: /minion assignment tiers/i });
    expect(within(tabs).getByRole("tab", { name: "Standard" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(within(tabs).getByRole("tab", { name: "Mechanical" }));
    const mechanicalControls = screen.getByRole("group", { name: "Mechanical Minion model" });
    fireEvent.click(within(mechanicalControls).getByRole("button", { name: "Opus 4.8" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      adaptiveMinionModelRouting: true,
      mechanicalMinionModel: "claude-opus-4-8",
      defaultMinionModel: "claude-sonnet-5",
      reasoningMinionModel: "claude-opus-4-8",
    }));
  });

  it("stores harness and concrete model when leader model changes", () => {
    const onChange = vi.fn();
    renderWithHarnesses([CLAUDE_ENTRY, CODEX_ENTRY], {
      settings: { defaultLeaderHarness: "claude", defaultLeaderModel: "claude-opus-4-8" },
      onSettingsChange: onChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");

    const leaderControls = screen.getByRole("group", { name: "Leader model and reasoning" });
    fireEvent.click(within(leaderControls).getByRole("tab", { name: /OpenAI/ }));

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
        defaultLeaderModel: "claude-opus-4-8",
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
    openCategory("Agent defaults");

    const leaderControls = screen.getByRole("group", { name: "Leader model and reasoning" });
    fireEvent.click(within(leaderControls).getByRole("button", { name: "XHigh" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultLeaderThinkingConfig: {
          enabled: true,
          effort: "xhigh",
          display: "summarized",
        },
      }),
    );

    const minionControls = screen.getByRole("group", { name: "Fixed Minion model and reasoning" });
    fireEvent.click(within(minionControls).getByRole("button", { name: "Hidden" }));
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

  it("keeps adaptive reasoning reachable inside each role's model menu", () => {
    const onChange = vi.fn();
    renderWithHarnesses([CLAUDE_ENTRY], {
      settings: {
        defaultLeaderHarness: "claude",
        defaultLeaderModel: "claude-opus-4-8",
        defaultLeaderThinkingConfig: {
          enabled: true,
          effort: "high",
          display: "summarized",
        },
      },
      onSettingsChange: onChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");
    const leaderControls = screen.getByRole("group", { name: "Leader model and reasoning" });
    const adaptiveReasoning = within(leaderControls).getByRole("checkbox", {
      name: /adaptive reasoning/i,
    });
    expect(adaptiveReasoning).toBeChecked();
    fireEvent.click(adaptiveReasoning);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultLeaderThinkingConfig: {
          enabled: false,
          effort: "high",
          display: "summarized",
        },
      }),
    );
  });

  it("keeps both role model menus expanded without disclosure controls", () => {
    renderWithHarnesses([CLAUDE_ENTRY], {
      settings: {
        defaultLeaderHarness: "claude",
        defaultLeaderModel: "claude-opus-4-8",
      },
      onSettingsChange: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Agent defaults");
    const leaderControls = screen.getByRole("group", { name: "Leader model and reasoning" });
    const minionControls = screen.getByRole("group", { name: "Fixed Minion model and reasoning" });
    expect(leaderControls).toBeVisible();
    expect(minionControls).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Configure (Leader|Minion) model and reasoning/ }),
    ).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("keeps edits local until Apply and emits the full action recipe", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{
          dashboardLeaderActions: [
            { id: "a1", name: "Improve label", prompt: "Improve old", icon: "sparkles" },
          ],
        }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");

    fireEvent.change(screen.getByDisplayValue("Improve label"), {
      target: { value: "Polish" },
    });
    fireEvent.change(screen.getByDisplayValue("Improve old"), {
      target: { value: "Improve new" },
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith({
      dashboardLeaderActions: [
        { id: "a1", name: "Polish", prompt: "Improve new", icon: "sparkles", skillIds: [] },
      ],
    });
  });

  it("keeps an incomplete existing recipe visible and shows local validation", () => {
    const onChange = vi.fn();
    render(<SettingsMenu settings={{ dashboardLeaderActions: [
      { id: "a1", name: "Review", prompt: "Review this", icon: "microscope" },
    ] }} onSettingsChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Instruction is required.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("edits icons through an accessible radio group", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{
          dashboardLeaderActions: [
            { id: "a1", name: "Improve label", prompt: "Improve old", icon: "sparkles" },
          ],
        }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");
    fireEvent.click(screen.getByRole("radio", { name: "Ship" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith({ dashboardLeaderActions: [
      { id: "a1", name: "Improve label", prompt: "Improve old", icon: "rocket", skillIds: [] },
    ] });
  });

  it("adds a new context action to the end of the list", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{
          dashboardLeaderActions: [
            { id: "a1", name: "Only", prompt: "Just one", icon: "play" },
          ],
        }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");

    fireEvent.click(screen.getByRole("button", { name: /add action/i }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "New action" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Do the new thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const next = onChange.mock.calls.at(-1)?.[0].dashboardLeaderActions;
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: "a1", name: "Only" });
    expect(next[1]).toMatchObject({ name: "New action", prompt: "Do the new thing", skillIds: [] });
    expect(typeof next[1].id).toBe("string");
    expect(next[1].id.length).toBeGreaterThan(0);
  });

  it("keeps a new draft through controlled rerenders and persists tagged skills", () => {
    function ControlledSettings() {
      const [settings, setSettings] = useState<import("./api.ts").ProjectSettings>({
        dashboardLeaderActions: [
          { id: "a1", name: "Only", prompt: "Just one", icon: "play", skillIds: [] },
        ],
      });
      return <SettingsMenu settings={settings} onSettingsChange={setSettings} />;
    }
    render(<ControlledSettings />);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");
    fireEvent.click(screen.getByRole("button", { name: /add action/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Model plan" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Plan from the model." } });
    expect(screen.queryByRole("checkbox", { name: /system model authoring/i })).toBeNull();
    const skillsSection = screen.getByText("Skills").closest("section");
    expect(skillsSection).not.toBeNull();
    const openPicker = within(skillsSection!).getByRole("button", { name: "Open skill picker" });
    expect(skillsSection).toContainElement(openPicker);
    expect(openPicker).toHaveClass("context-actions__apply");
    expect(openPicker).toHaveTextContent("Add");
    fireEvent.click(openPicker);
    const skillSearch = screen.getByRole("searchbox", { name: "Search available skills" });
    fireEvent.change(skillSearch, { target: { value: "system model" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /system model authoring/i }));
    expect(screen.getByLabelText("Selected skills")).toHaveTextContent("System Model Authoring");
    fireEvent.click(screen.getByRole("button", { name: "Close skill picker" }));
    expect(screen.queryByRole("checkbox", { name: /system model authoring/i })).toBeNull();
    expect(screen.getByLabelText("Selected skills")).toHaveTextContent("System Model Authoring");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByRole("option", { name: /model plan1 skill/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Model plan");
  });

  it("removes a context action", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{
          dashboardLeaderActions: [
            { id: "a1", name: "Keep", prompt: "p1", icon: "play" },
            { id: "a2", name: "Drop", prompt: "p2", icon: "bug" },
          ],
        }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");

    fireEvent.click(screen.getByRole("option", { name: /drop/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove drop/i }));

    expect(onChange).toHaveBeenCalledWith({
      dashboardLeaderActions: [
        { id: "a1", name: "Keep", prompt: "p1", icon: "play", skillIds: [] },
      ],
    });
  });

  it("reorders context actions with the move controls", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu
        settings={{
          dashboardLeaderActions: [
            { id: "a1", name: "First", prompt: "p1", icon: "play" },
            { id: "a2", name: "Second", prompt: "p2", icon: "bug" },
          ],
        }}
        onSettingsChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");

    fireEvent.click(screen.getByRole("button", { name: /move first down/i }));

    expect(onChange).toHaveBeenCalledWith({
      dashboardLeaderActions: [
        { id: "a2", name: "Second", prompt: "p2", icon: "bug", skillIds: [] },
        { id: "a1", name: "First", prompt: "p1", icon: "play", skillIds: [] },
      ],
    });
  });

  it("filters action recipes and restores the list from the placeholder search input", () => {
    render(
      <SettingsMenu
        settings={{
          dashboardLeaderActions: [
            { id: "a1", name: "Review", prompt: "Review this", icon: "play" },
            { id: "a2", name: "Ship", prompt: "Ship this", icon: "rocket" },
          ],
        }}
        onSettingsChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    openCategory("Context actions");

    const search = screen.getByRole("searchbox", { name: "Search actions" });
    expect(search).toHaveAttribute("placeholder", "Search actions…");
    expect(search.closest("label")).toBeNull();
    expect(screen.queryByText("Search actions")).toBeNull();
    fireEvent.change(search, { target: { value: "ship" } });
    expect(screen.getByRole("option", { name: /ship/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /review/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear action search" }));
    expect(search).toHaveValue("");
    expect(screen.getByRole("option", { name: /review/i })).toBeInTheDocument();
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
