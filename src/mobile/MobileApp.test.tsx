import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectSettings, listProjects, restartServer, updateProjectSettings } from "../api.ts";
import MobileApp from "./MobileApp.tsx";
import { themeMap } from "../themes.ts";

const send = vi.fn();
const manualReconnect = vi.fn();
const socketSubscribers: Array<(msg: unknown) => void> = [];
const socketSubscribe = vi.fn((
  topicOrFn: string | ((msg: unknown) => void),
  maybeFn?: (msg: unknown) => void,
) => {
  const fn = typeof topicOrFn === "function" ? topicOrFn : maybeFn;
  if (!fn) return () => {};
  socketSubscribers.push(fn);
  return () => {
    const index = socketSubscribers.indexOf(fn);
    if (index >= 0) socketSubscribers.splice(index, 1);
  };
});

function emitSocketMessage(msg: unknown) {
  act(() => {
    for (const subscriber of [...socketSubscribers]) subscriber(msg);
  });
}

vi.mock("../api.ts", () => ({
  getProjectSettings: vi.fn(async () => ({})),
  listProjects: vi.fn(async () => []),
  getHarnessReadiness: vi.fn(async () => ({ schemaVersion: 1, checkedAt: "", expiresAt: "", ready: true, readyHarnesses: ["claude"], harnesses: [] })),
  restartServer: vi.fn(async () => ({ ok: true, restarting: true })),
  updateProjectSettings: vi.fn(async () => ({})),
}));

vi.mock("../use-socket.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../use-socket.ts")>(),
  subscribeSocketTopic: (
    socketSubscribe: ((topic: string, fn: (msg: unknown) => void) => () => void) | undefined,
    topic: string,
    fn: (msg: unknown) => void,
  ) => socketSubscribe?.(topic, fn),
  useSocket: () => ({
    connected: true,
    send,
    subscribe: socketSubscribe,
    reconnectState: "connected",
    manualReconnect,
  }),
}));

function installPushGlobals() {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => null),
    },
  };
  const serviceWorker = {
    ready: Promise.resolve(registration),
    register: vi.fn(async () => registration),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn(),
  });
  Object.defineProperty(window, "PushManager", {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: Notification,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });
}

afterEach(() => {
  send.mockClear();
  manualReconnect.mockClear();
  socketSubscribers.splice(0);
  socketSubscribe.mockClear();
  vi.mocked(listProjects).mockReset();
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(getProjectSettings).mockReset();
  vi.mocked(getProjectSettings).mockResolvedValue({});
  vi.mocked(restartServer).mockReset();
  vi.mocked(restartServer).mockResolvedValue({ ok: true, restarting: true });
  vi.mocked(updateProjectSettings).mockReset();
  vi.mocked(updateProjectSettings).mockResolvedValue({});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("MobileApp", () => {
  it.each([
    ["daybook", "daybook"],
    ["obsidian", "obsidian"],
    ["removed-theme", "midnight"],
  ])("applies the saved %s theme on the standalone mobile route", (savedId, expectedId) => {
    const root = document.documentElement;
    const previousStyle = root.getAttribute("style");
    const previousTheme = root.getAttribute("data-theme");
    const previousSavedTheme = localStorage.getItem("canvas-theme");
    try {
      localStorage.setItem("canvas-theme", savedId);
      render(<MobileApp />);

      const theme = themeMap[expectedId!]!;
      expect(root.dataset["theme"]).toBe(expectedId);
      expect(root.style.getPropertyValue("--bg-primary")).toBe(theme.vars["--bg-primary"]);
      expect(root.style.getPropertyValue("--text-on-accent")).toBe(theme.vars["--text-on-accent"]);
      expect(root.style.getPropertyValue("--font-sans")).toBe(theme.fonts.sans);
    } finally {
      if (previousStyle === null) root.removeAttribute("style");
      else root.setAttribute("style", previousStyle);
      if (previousTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previousTheme);
      if (previousSavedTheme === null) localStorage.removeItem("canvas-theme");
      else localStorage.setItem("canvas-theme", previousSavedTheme);
    }
  });

  it("shows the enable notifications control from the default push state", async () => {
    installPushGlobals();

    render(<MobileApp />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enable notifications" })).toHaveAttribute("title", "Enable notifications");
    });
  });

  it("shows the project picker first and scopes to a project on selection", async () => {
    installPushGlobals();
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
    ]);

    render(<MobileApp />);

    // Project selection is the first screen — no Activity tabbar yet.
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Projects" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();

    // Selecting a project scopes the app: Activity becomes the active screen,
    // the tabbar appears, and the consolidated header exposes project back.
    fireEvent.click(screen.getByText("Alpha"));

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Activity" })).toBeInTheDocument();
    });
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeInTheDocument();
    const backButton = screen.getByRole("button", { name: "Back to projects" });
    expect(backButton).toBeInTheDocument();
    expect(screen.getAllByText("Activity").length).toBeGreaterThan(0);

    // The back button returns to project selection.
    fireEvent.click(backButton);
    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Projects" })).toBeInTheDocument();
    });
  });

  it("opens the existing launch screen from the no-sessions Activity action", async () => {
    installPushGlobals();
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
    ]);

    render(<MobileApp />);
    fireEvent.click(await screen.findByText("Alpha"));

    const emptyAction = await screen.findByRole("button", { name: "New leader" });
    fireEvent.click(emptyAction);

    expect(await screen.findByRole("main", { name: "New leader" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-current", "page");
  });

  it("opens review mode from a mobile approval deep link", async () => {
    installPushGlobals();
    window.history.replaceState(null, "", "/m?session=s-1&review=1");

    render(<MobileApp />);

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Review changes" })).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "s-1" })).toBeInTheDocument();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "get_worktree_diff",
        sessionKey: "s-1",
      }),
    );
  });

  it("hides the app context header while viewing an active session chat", async () => {
    installPushGlobals();
    window.history.replaceState(null, "", "/m?session=s-1");

    render(<MobileApp />);

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Session chat" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Minions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable notifications" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to activity" })).toBeInTheDocument();
  });

  it("keeps the current conversation available after returning to Activity", async () => {
    installPushGlobals();
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
    ]);

    render(<MobileApp />);
    fireEvent.click(await screen.findByText("Alpha"));
    emitSocketMessage({
      type: "session_list",
      sessions: [{
        sessionKey: "leader-1",
        sessionId: null,
        status: "running",
        cwd: "/work/alpha",
        taskName: "Mobile audit",
        role: "leader",
      }],
    });

    fireEvent.click(await screen.findByText("Mobile audit"));
    fireEvent.click(screen.getByRole("button", { name: "Back to activity" }));

    const chatTab = screen.getByRole("button", { name: "Chat" });
    expect(chatTab).toBeEnabled();
    fireEvent.click(chatTab);
    expect(await screen.findByRole("heading", { name: "Mobile audit" })).toBeInTheDocument();
  });

  it("keeps needs-you work visible in the persistent navigation", async () => {
    installPushGlobals();
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
    ]);

    render(<MobileApp />);
    fireEvent.click(await screen.findByText("Alpha"));
    emitSocketMessage({
      type: "session_list",
      sessions: [{
        sessionKey: "leader-error",
        sessionId: null,
        status: "error",
        cwd: "/work/alpha",
        taskName: "Needs recovery",
        role: "leader",
      }],
    });

    expect(await screen.findByRole("button", { name: "Activity, 1 need you" })).toHaveTextContent("1");
  });

  it("manages default Minion settings from the mobile settings tab", async () => {
    installPushGlobals();
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
    ]);
    vi.mocked(getProjectSettings).mockResolvedValue({
      defaultMinionHarness: "claude",
      defaultMinionModel: "claude-sonnet-5",
    });

    render(<MobileApp />);

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Projects" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(getProjectSettings).toHaveBeenCalledWith("alpha");
    });
    expect(screen.getByRole("main", { name: "Settings" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude::claude-opus-4-8" },
    });

    await waitFor(() => {
      expect(updateProjectSettings).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          defaultMinionHarness: "claude",
          defaultMinionModel: "claude-opus-4-8",
        }),
      );
    });
  });

  it("confirms before restarting the server from mobile settings", async () => {
    installPushGlobals();
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
    ]);

    render(<MobileApp />);

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Projects" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Settings" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Restart Server" }));

    expect(screen.getByRole("dialog", { name: "Restart Minions server" })).toBeInTheDocument();
    expect(screen.getByText(/active sessions will disconnect/i)).toBeInTheDocument();
    expect(restartServer).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Restart Server" })[1]!);

    await screen.findByText(/restart requested/i);
    expect(restartServer).toHaveBeenCalledTimes(1);
  });

  it("shows an actionable activity notice when mobile launch hits the session limit", async () => {
    installPushGlobals();
    let uuidSequence = 10;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
      `00000000-0000-4000-8000-${String(uuidSequence++).padStart(12, "0")}`);
    vi.mocked(listProjects).mockResolvedValue([
      { id: "alpha", name: "Alpha", path: "/work/alpha", lastOpened: "2026-06-01T00:00:00.000Z", hasSidecar: true },
    ]);

    render(<MobileApp />);

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Projects" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Alpha"));

    emitSocketMessage({
      type: "session_list",
      sessions: [
        {
          sessionKey: "leader-old",
          sessionId: null,
          status: "idle",
          cwd: "/work/alpha",
          taskName: "Old idle work",
          role: "leader",
        },
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Start a new leader" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch leader" }));

    const createPayload = send.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "create_work_item",
    )?.[0] as { requestId: string } | undefined;
    expect(createPayload).toMatchObject({
      type: "create_work_item", workspaceId: "alpha", title: "Start a new leader",
      changeMode: "live",
    });

    emitSocketMessage({
      type: "work_item_response", command: "create_work_item",
      requestId: createPayload!.requestId, success: true,
      result: {
        workItem: {
          id: "work-new", projectId: "alpha", projectPath: "/work/alpha",
          title: "Start a new leader",
          lifecycle: { runtimeState: "draft", outcome: "none", resolution: "open",
            changeMode: "live", integrationState: "live_clean", lifecycleRevision: 0 },
          waitKind: null, currentRunKey: null, iteration: 0,
          lastTransitionAt: 1, createdAt: 1, updatedAt: 1,
        },
        bindings: [], currentRun: null, runs: [], nextCursor: null,
      },
    });
    const continuePayload = send.mock.calls.find(
      ([message]) => typeof message === "object" && message !== null
        && "type" in message && message.type === "continue_work_item",
    )?.[0] as { requestId: string } | undefined;
    expect(continuePayload).toMatchObject({
      type: "continue_work_item", workItemId: "work-new", orchestrationMode: "auto",
    });
    emitSocketMessage({
      type: "work_item_response", command: "continue_work_item",
      requestId: continuePayload!.requestId, success: false, code: "internal",
      error: "Maximum session limit (50) reached. Remove unused sessions first.",
    });

    expect(await screen.findByRole("alert", { name: "Session limit reached" })).toBeInTheDocument();
    expect(screen.getByText(/50 non-stopped sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/tap Stop/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open session to stop" }));

    await waitFor(() => {
      expect(screen.getByRole("main", { name: "Session chat" })).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Old idle work" })).toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);
    expect(send).toHaveBeenCalledWith({
      type: "stop_session",
      sessionKey: "leader-old",
    });
  });
});
