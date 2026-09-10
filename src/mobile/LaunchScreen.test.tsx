import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectSettings, getProjectSkills, listProjects } from "../api.ts";
import { HarnessListProvider } from "../use-harness-list.tsx";
import type { HarnessListEntry } from "../use-socket.ts";
import type { SkillTemplate } from "../skills/types.ts";
import { clearSkills } from "../skills/registry.ts";
import { LaunchScreen } from "./LaunchScreen.tsx";

const CLAUDE_HARNESS: HarnessListEntry = {
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
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
  ],
  commands: [],
  agents: [],
  account: { provider: "anthropic" },
};

const CODEX_HARNESS: HarnessListEntry = {
  name: "codex",
  capabilities: {
    mutationInterception: "observe_only",
    thinking: true,
    promptCaching: false,
    mcp: true,
    permissionPrompts: true,
    resume: true,
    partialMessages: true,
    builtInFilesystem: true,
    sandboxEnforcement: {
      filesystem: ["read-only", "workspace-write", "unrestricted"],
      approval: true,
    },
  },
  builtInTools: [],
  models: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
  ],
  commands: [],
  agents: [],
  account: { provider: "openai" },
};

const NO_REASONING_HARNESS: HarnessListEntry = {
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
    sandboxEnforcement: { filesystem: [], approval: false },
  },
  builtInTools: [],
  models: [{ id: "echo-fast", label: "Echo Fast" }],
  commands: [],
  agents: [],
  account: { provider: "echo" },
};

vi.mock("../api.ts", () => ({
  listProjects: vi.fn(),
  getProjectSettings: vi.fn().mockResolvedValue({}),
  getProjectSkills: vi.fn().mockResolvedValue([]),
  saveProjectSkills: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.mocked(listProjects).mockReset();
  vi.mocked(getProjectSettings).mockReset();
  vi.mocked(getProjectSettings).mockResolvedValue({});
  vi.mocked(getProjectSkills).mockReset();
  vi.mocked(getProjectSkills).mockResolvedValue([]);
  clearSkills();
  vi.restoreAllMocks();
});

describe("LaunchScreen", () => {
  it("keeps run setup collapsed behind a native, truthful disclosure", async () => {
    vi.mocked(getProjectSettings).mockResolvedValue({
      defaultWorktreeIsolation: true,
      defaultSandboxPolicy: {
        filesystemScope: "read-only",
        approvalPolicy: "on-request",
      },
    });

    render(
      <LaunchScreen
        canonicalLaunch={vi.fn()}
        onLaunched={vi.fn()}
        lockedProject={{ id: "compact", path: "/work/compact", name: "Compact" }}
      />,
    );

    const disclosure = screen.getByTestId("launch-run-setup");
    expect(disclosure).not.toHaveAttribute("open");
    expect(within(disclosure).getByText("Model · Project default")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(disclosure).getByText(/Read only · Worktree · No files · No skills/)).toBeInTheDocument();
    });

    const summary = disclosure.querySelector("summary");
    expect(summary).not.toBeNull();
    summary!.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary!);
    expect(disclosure).toHaveAttribute("open");
    expect(within(disclosure).getByLabelText("Model")).toBeInTheDocument();
    expect(within(disclosure).getByLabelText("Worktree isolation")).toBeChecked();
    expect(within(disclosure).getByLabelText("Read only")).toBeChecked();
  });

  it("separates the prompt label from its live character counter", () => {
    render(
      <LaunchScreen
        canonicalLaunch={vi.fn()}
        onLaunched={vi.fn()}
        lockedProject={{ id: "project-test", path: "/work/prompt", name: "Prompt" }}
      />,
    );

    const prompt = screen.getByLabelText("Prompt");
    const counter = screen.getByText("0 characters");
    expect(prompt).toHaveAttribute("aria-describedby", counter.id);

    fireEvent.change(prompt, { target: { value: "Ship it" } });
    expect(counter).toHaveTextContent("7 characters");
  });

  it("inherits the desktop leader defaults for the selected project", async () => {
    vi.mocked(getProjectSettings).mockResolvedValue({
      defaultLeaderHarness: "codex",
      defaultLeaderModel: "gpt-5.5-codex",
      defaultLeaderThinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      defaultPermissionMode: "default",
      defaultSandboxPolicy: {
        filesystemScope: "read-only",
        approvalPolicy: "always",
      },
      defaultWorktreeIsolation: true,
    });
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          canonicalLaunch={launch}
          onLaunched={vi.fn()}
          lockedProject={{ id: "alpha", path: "/work/alpha", name: "Alpha" }}
        />
      </HarnessListProvider>,
    );

    act(() => {
      subscriber?.({ type: "harness_list", harnesses: [CLAUDE_HARNESS, CODEX_HARNESS] });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Model")).toHaveValue("codex::gpt-5.5-codex");
    });
    expect(screen.getByLabelText("Worktree isolation")).toBeChecked();
    expect(screen.getByLabelText("Read only")).toBeChecked();

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Use the project defaults" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      changeMode: "worktree",
      options: expect.objectContaining({
      harness: "codex",
      model: "gpt-5.5-codex",
      thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      permissionMode: "default",
      sandboxPolicy: {
        filesystemScope: "read-only",
        approvalPolicy: "always",
      },

      }),
    }), expect.any(Function), expect.any(Function));
  });

  it("lets a mobile Leader grant full host access without changing approval policy", async () => {
    vi.mocked(getProjectSettings).mockResolvedValue({
      defaultLeaderHarness: "codex",
      defaultLeaderModel: "gpt-5.5-codex",
      defaultSandboxPolicy: {
        filesystemScope: "workspace-write",
        approvalPolicy: "on-request",
      },
    });
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          canonicalLaunch={launch}
          onLaunched={vi.fn()}
          lockedProject={{ id: "host-access", path: "/work/host-access", name: "Host access" }}
        />
      </HarnessListProvider>,
    );
    act(() => {
      subscriber?.({ type: "harness_list", harnesses: [CLAUDE_HARNESS, CODEX_HARNESS] });
    });

    await waitFor(() => expect(screen.getByLabelText("Workspace write")).toBeChecked());
    fireEvent.click(screen.getByLabelText("Full Host - Leader + Minions"));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Use host tools" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({

      options: expect.objectContaining({

      sandboxPolicy: {
        filesystemScope: "unrestricted",
        approvalPolicy: "on-request",
        fullHostScope: "leader-and-minions",
      },

      }),
    }), expect.any(Function), expect.any(Function));
  });

  it("renders projects, validates required input, and launches a leader", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      {
        id: "alpha",
        name: "Alpha",
        path: "/work/alpha",
        lastOpened: "2026-06-01T00:00:00.000Z",
        hasSidecar: true,
      },
      {
        id: "beta",
        name: "Beta",
        path: "/work/beta",
        lastOpened: "2026-06-02T00:00:00.000Z",
        hasSidecar: false,
      },
    ]);
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));
    const onLaunched = vi.fn();

    render(<LaunchScreen canonicalLaunch={launch} onLaunched={onLaunched} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });
    expect(screen.getByText("/work/beta")).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Launch leader" });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/Alpha/));
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Build the mobile launch flow" },
    });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "Build the mobile launch flow",
        changeMode: "live",
      options: expect.objectContaining({

      }),
    }), expect.any(Function), expect.any(Function));
    });
    expect(onLaunched).toHaveBeenCalledWith("run-1");
  });

  it("disables canonical launch immediately and ignores duplicate submissions", () => {
    const canonicalLaunch = vi.fn();

    render(
      <LaunchScreen
        onLaunched={vi.fn()}
        canonicalLaunch={canonicalLaunch}
        lockedProject={{ id: "alpha", path: "/work/alpha", name: "Alpha" }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Launch once" },
    });
    const submit = screen.getByRole("button", { name: "Launch leader" });
    const form = submit.closest("form");
    expect(form).not.toBeNull();

    fireEvent.click(submit);
    fireEvent.submit(form!);

    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(canonicalLaunch).toHaveBeenCalledTimes(1);
  });

  it("re-enables canonical launch after an error", () => {
    const canonicalLaunch = vi.fn((
      _input: unknown,
      _onStarted: (sessionKey: string) => void,
      onError: (error: string) => void,
    ) => onError("Unable to launch"));

    render(
      <LaunchScreen
        onLaunched={vi.fn()}
        canonicalLaunch={canonicalLaunch}
        lockedProject={{ id: "alpha", path: "/work/alpha", name: "Alpha" }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Try launch" },
    });
    const submit = screen.getByRole("button", { name: "Launch leader" });
    fireEvent.click(submit);

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to launch");
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute("aria-busy");
  });

  it("does not launch a Leader without project identity", () => {
    const canonicalLaunch = vi.fn();
    render(<LaunchScreen canonicalLaunch={canonicalLaunch} onLaunched={vi.fn()}
      lockedProject={{ path: "/work/unbound", name: "Unbound" }} />);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));
    expect(canonicalLaunch).not.toHaveBeenCalled();
    expect(screen.getByText("Select a project before starting a Leader.")).toBeInTheDocument();
  });

  it("locks to a project: hides the picker, skips the fetch, and launches into it", async () => {
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));
    const onLaunched = vi.fn();

    render(
      <LaunchScreen
        canonicalLaunch={launch}
        onLaunched={onLaunched}
        lockedProject={{ id: "project-test", path: "/work/gamma", name: "Gamma" }}
      />,
    );

    // No project list is fetched when locked.
    expect(listProjects).not.toHaveBeenCalled();
    // The picker is replaced by the locked project label.
    expect(screen.queryByText("Recent projects")).not.toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Launch leader" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Do the thing" },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "Do the thing",
        changeMode: "live",
      options: expect.objectContaining({

      }),
    }), expect.any(Function), expect.any(Function));
    });
    expect(onLaunched).toHaveBeenCalledWith("run-1");
  });

  it("lists models from every harness (Anthropic + OpenAI) and launches with the chosen model + harness", async () => {
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));
    const onLaunched = vi.fn();

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected={true}>
        <LaunchScreen
          canonicalLaunch={launch}
          onLaunched={onLaunched}
          lockedProject={{ id: "project-test", path: "/work/epsilon", name: "Epsilon" }}
        />
      </HarnessListProvider>,
    );

    // Server answers list_harnesses → models from BOTH harnesses populate the select.
    act(() => {
      subscriber?.({ type: "harness_list", harnesses: [CLAUDE_HARNESS, CODEX_HARNESS] });
    });

    const select = screen.getByLabelText("Model");
    // Provider groups are present…
    const groupLabels = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groupLabels).toEqual(["Anthropic", "OpenAI"]);
    // …and OpenAI models are now visible (the reported bug).
    expect(screen.getByRole("option", { name: "Sonnet 5" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT-5.5" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT-5.5 Codex" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do work" } });
    fireEvent.change(select, { target: { value: "codex::gpt-5.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    await waitFor(() => {
      expect(launch).toHaveBeenCalledTimes(1);
    });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Do work",
      changeMode: "live",
      options: expect.objectContaining({
      model: "gpt-5.5",
      harness: "codex",

      }),
    }), expect.any(Function), expect.any(Function));
  });

  it("lets a mobile Leader override reasoning for the selected model", async () => {
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          canonicalLaunch={launch}
          onLaunched={vi.fn()}
          lockedProject={{ id: "project-test", path: "/work/reasoning", name: "Reasoning" }}
        />
      </HarnessListProvider>,
    );

    act(() => {
      subscriber?.({ type: "harness_list", harnesses: [CLAUDE_HARNESS, CODEX_HARNESS] });
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "codex::gpt-5.5-codex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Medium" }));
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Use focused reasoning" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({

      options: expect.objectContaining({

      model: "gpt-5.5-codex",
      harness: "codex",
      thinkingConfig: { enabled: true, effort: "medium", display: "omitted" },

      }),
    }), expect.any(Function), expect.any(Function));
  });

  it("explains capability gating and disables reasoning for unsupported models", async () => {
    vi.mocked(getProjectSettings).mockResolvedValue({
      defaultLeaderThinkingConfig: { enabled: true, effort: "high", display: "summarized" },
    });
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          canonicalLaunch={launch}
          onLaunched={vi.fn()}
          lockedProject={{ id: "gated", path: "/work/gated", name: "Gated" }}
        />
      </HarnessListProvider>,
    );
    act(() => {
      subscriber?.({ type: "harness_list", harnesses: [NO_REASONING_HARNESS] });
    });
    await waitFor(() => {
      expect(screen.getByText("Default · high")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "echo::echo-fast" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/does not expose reasoning controls/i);
    expect(screen.getByText("Unmanaged by the selected harness")).toBeInTheDocument();
    expect(screen.getByText("Workspace · unmanaged")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Run safely" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({

      options: expect.objectContaining({

      model: "echo-fast",
      harness: "echo",
      thinkingConfig: { enabled: false, effort: "high", display: "summarized" },

      }),
    }), expect.any(Function), expect.any(Function));
  });

  it("omits the model when left on Default", async () => {
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));

    render(
      <LaunchScreen
        canonicalLaunch={launch}
        onLaunched={vi.fn()}
        lockedProject={{ id: "project-test", path: "/work/zeta", name: "Zeta" }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    await waitFor(() => {
      expect(launch).toHaveBeenCalledTimes(1);
    });
    expect((launch.mock.calls[0]![0] as { options: object }).options).not.toHaveProperty("model");
  });

  it("launches with selected text files folded into the initial prompt", async () => {
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));

    render(
      <LaunchScreen
        canonicalLaunch={launch}
        onLaunched={vi.fn()}
        lockedProject={{ id: "project-test", path: "/work/files", name: "Files" }}
      />,
    );

    const submit = screen.getByRole("button", { name: "Launch leader" });
    expect(submit).toBeDisabled();

    const file = new File(["<main>Hello</main>"], "index.html", { type: "text/html" });
    fireEvent.change(screen.getByLabelText("Launch file attachments"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByText("index.html")).toBeInTheDocument();
    });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "Attached file: index.html\nMedia type: text/html\n```html\n<main>Hello</main>\n```",
        changeMode: "live",
      options: expect.objectContaining({

      }),
    }), expect.any(Function), expect.any(Function));
    });
  });

  const LINT_SKILL: SkillTemplate = {
    id: "lint",
    name: "Lint Cleanup",
    description: "Fix lint violations",
    category: "code",
    icon: "🧹",
    accentColor: "#7c3aed",
    template: "Clean up all lint violations.",
    variables: [],
  };

  it("loads project skills and arms the leader with skillIds + a compiled system prompt", async () => {
    vi.mocked(getProjectSkills).mockResolvedValue([LINT_SKILL]);
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));

    render(
      <LaunchScreen
        canonicalLaunch={launch}
        onLaunched={vi.fn()}
        lockedProject={{ id: "proj-skills", path: "/work/skills", name: "Skills" }}
      />,
    );

    // Skills load for the locked project, enabling the Add button.
    const addButton = await screen.findByRole("button", { name: "Add" });
    await waitFor(() => expect(addButton).toBeEnabled());

    fireEvent.click(addButton);
    // The skill appears in the bottom-sheet browser; tap to arm it.
    fireEvent.click(screen.getByRole("button", { name: /Lint Cleanup/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Done/ }));

    // A chip now summarizes the armed skill.
    expect(screen.getByText("Lint Cleanup")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const payload = (launch.mock.calls[0]![0] as { options: unknown }).options as {
      skillIds?: string[];
      skillValues?: Record<string, Record<string, string>>;
      systemPrompt?: string;
    };
    expect(payload.skillIds).toEqual(["lint"]);
    expect(payload.skillValues).toEqual({});
    expect(payload.systemPrompt).toContain("Clean up all lint violations.");
  });

  it("omits skill fields from the payload when no skills are armed", async () => {
    vi.mocked(getProjectSkills).mockResolvedValue([LINT_SKILL]);
    const launch = vi.fn((_input: unknown, onStarted: (key: string) => void) => onStarted("run-1"));

    render(
      <LaunchScreen
        canonicalLaunch={launch}
        onLaunched={vi.fn()}
        lockedProject={{ id: "proj-skills", path: "/work/skills", name: "Skills" }}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const payload = (launch.mock.calls[0]![0] as { options: unknown }).options as Record<string, unknown>;
    expect(payload).not.toHaveProperty("skillIds");
    expect(payload).not.toHaveProperty("skillValues");
    expect(payload).not.toHaveProperty("systemPrompt");
  });
});
