import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    const send = vi.fn();
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          send={send}
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

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "create_session",
      workspaceId: "alpha",
      harness: "codex",
      model: "gpt-5.5-codex",
      thinkingConfig: { enabled: true, effort: "high", display: "summarized" },
      permissionMode: "default",
      sandboxPolicy: {
        filesystemScope: "read-only",
        approvalPolicy: "always",
      },
      worktreeIsolation: true,
    }));
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
    const send = vi.fn();

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          send={send}
          onLaunched={vi.fn()}
          lockedProject={{ id: "host-access", path: "/work/host-access", name: "Host access" }}
        />
      </HarnessListProvider>,
    );
    act(() => {
      subscriber?.({ type: "harness_list", harnesses: [CLAUDE_HARNESS, CODEX_HARNESS] });
    });

    await waitFor(() => expect(screen.getByLabelText("Workspace write")).toBeChecked());
    fireEvent.click(screen.getByLabelText("Full host access"));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Use host tools" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sandboxPolicy: {
        filesystemScope: "unrestricted",
        approvalPolicy: "on-request",
      },
    }));
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
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const send = vi.fn();
    const onLaunched = vi.fn();

    render(<LaunchScreen send={send} onLaunched={onLaunched} />);

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
      expect(send).toHaveBeenCalledWith({
        type: "create_session",
        sessionKey: "leader-00000000-0000-4000-8000-000000000001",
        prompt: "Build the mobile launch flow",
        role: "leader",
        workspaceId: "alpha",
        worktreeIsolation: false,
      });
    });
    expect(onLaunched).toHaveBeenCalledWith("leader-00000000-0000-4000-8000-000000000001");
  });

  it("still launches when crypto.randomUUID is unavailable (non-secure LAN context)", async () => {
    // Regression: on a phone over plain HTTP, crypto.randomUUID is undefined.
    // Minting the session key must not throw, so the leader still launches.
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues<T extends ArrayBufferView>(array: T): T {
          const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
          for (let i = 0; i < bytes.length; i += 1) bytes[i] = i + 1;
          return array;
        },
      },
    });

    try {
      const send = vi.fn();
      const onLaunched = vi.fn();

      render(
        <LaunchScreen
          send={send}
          onLaunched={onLaunched}
          lockedProject={{ path: "/work/delta", name: "Delta" }}
        />,
      );

      fireEvent.change(screen.getByLabelText("Prompt"), {
        target: { value: "Ship it" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

      await waitFor(() => {
        expect(send).toHaveBeenCalledTimes(1);
      });
      const payload = send.mock.calls[0]![0] as { type: string; sessionKey: string };
      expect(payload.type).toBe("create_session");
      expect(payload.sessionKey).toMatch(
        /^leader-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(onLaunched).toHaveBeenCalledWith(payload.sessionKey);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it("locks to a project: hides the picker, skips the fetch, and launches into it", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002");
    const send = vi.fn();
    const onLaunched = vi.fn();

    render(
      <LaunchScreen
        send={send}
        onLaunched={onLaunched}
        lockedProject={{ path: "/work/gamma", name: "Gamma" }}
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
      expect(send).toHaveBeenCalledWith({
        type: "create_session",
        sessionKey: "leader-00000000-0000-4000-8000-000000000002",
        prompt: "Do the thing",
        role: "leader",
        cwd: "/work/gamma",
        worktreeIsolation: false,
      });
    });
    expect(onLaunched).toHaveBeenCalledWith("leader-00000000-0000-4000-8000-000000000002");
  });

  it("lists models from every harness (Anthropic + OpenAI) and launches with the chosen model + harness", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000003");
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });
    const send = vi.fn();
    const onLaunched = vi.fn();

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected={true}>
        <LaunchScreen
          send={send}
          onLaunched={onLaunched}
          lockedProject={{ path: "/work/epsilon", name: "Epsilon" }}
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
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send).toHaveBeenCalledWith({
      type: "create_session",
      sessionKey: "leader-00000000-0000-4000-8000-000000000003",
      prompt: "Do work",
      role: "leader",
      cwd: "/work/epsilon",
      worktreeIsolation: false,
      model: "gpt-5.5",
      harness: "codex",
    });
  });

  it("lets a mobile Leader override reasoning for the selected model", async () => {
    let subscriber: ((msg: unknown) => void) | undefined;
    const subscribe = vi.fn((fn: (msg: unknown) => void) => {
      subscriber = fn;
      return () => {};
    });
    const send = vi.fn();

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          send={send}
          onLaunched={vi.fn()}
          lockedProject={{ path: "/work/reasoning", name: "Reasoning" }}
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

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.5-codex",
      harness: "codex",
      thinkingConfig: { enabled: true, effort: "medium", display: "omitted" },
    }));
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
    const send = vi.fn();

    render(
      <HarnessListProvider send={vi.fn()} subscribe={subscribe} connected>
        <LaunchScreen
          send={send}
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

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      model: "echo-fast",
      harness: "echo",
      thinkingConfig: { enabled: false, effort: "high", display: "summarized" },
    }));
  });

  it("omits the model when left on Default", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000004");
    const send = vi.fn();

    render(
      <LaunchScreen
        send={send}
        onLaunched={vi.fn()}
        lockedProject={{ path: "/work/zeta", name: "Zeta" }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send.mock.calls[0]![0]).not.toHaveProperty("model");
  });

  it("launches with selected text files folded into the initial prompt", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000005");
    const send = vi.fn();

    render(
      <LaunchScreen
        send={send}
        onLaunched={vi.fn()}
        lockedProject={{ path: "/work/files", name: "Files" }}
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
      expect(send).toHaveBeenCalledWith({
        type: "create_session",
        sessionKey: "leader-00000000-0000-4000-8000-000000000005",
        prompt: "Attached file: index.html\nMedia type: text/html\n```html\n<main>Hello</main>\n```",
        role: "leader",
        cwd: "/work/files",
        worktreeIsolation: false,
      });
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
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000006");
    const send = vi.fn();

    render(
      <LaunchScreen
        send={send}
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

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const payload = send.mock.calls[0]![0] as {
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
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000007");
    const send = vi.fn();

    render(
      <LaunchScreen
        send={send}
        onLaunched={vi.fn()}
        lockedProject={{ id: "proj-skills", path: "/work/skills", name: "Skills" }}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const payload = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("skillIds");
    expect(payload).not.toHaveProperty("skillValues");
    expect(payload).not.toHaveProperty("systemPrompt");
  });
});
