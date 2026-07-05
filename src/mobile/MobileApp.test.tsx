import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectSettings, listProjects, restartServer, updateProjectSettings } from "../api.ts";
import MobileApp from "./MobileApp.tsx";

const send = vi.fn();
const manualReconnect = vi.fn();

vi.mock("../api.ts", () => ({
  getProjectSettings: vi.fn(async () => ({})),
  listProjects: vi.fn(async () => []),
  restartServer: vi.fn(async () => ({ ok: true, restarting: true })),
  updateProjectSettings: vi.fn(async () => ({})),
}));

vi.mock("../use-socket.ts", () => ({
  subscribeSocketTopic: (
    socketSubscribe: ((topic: string, fn: (msg: unknown) => void) => () => void) | undefined,
    topic: string,
    fn: (msg: unknown) => void,
  ) => socketSubscribe?.(topic, fn),
  useSocket: () => ({
    connected: true,
    send,
    subscribe: vi.fn(() => () => {}),
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
  it("shows the enable notifications control from the default push state", async () => {
    installPushGlobals();

    render(<MobileApp />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enable notifications" })).toHaveTextContent("Alerts");
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
});
