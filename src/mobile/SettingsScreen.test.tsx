import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getProjectSettings,
  restartServer,
  updateProjectSettings,
} from "../api.ts";
import { HarnessListProvider } from "../use-harness-list.tsx";
import type { ServerMessage } from "../use-socket.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import { SettingsScreen } from "./SettingsScreen.tsx";

vi.mock("../api.ts", () => ({
  getProjectSettings: vi.fn(),
  restartServer: vi.fn(),
  updateProjectSettings: vi.fn(),
}));

function session(overrides: Partial<MobileSessionInfo>): MobileSessionInfo {
  return {
    sessionKey: "session-1",
    sessionId: null,
    status: "running",
    cwd: "/work/app",
    totalCost: 0,
    turns: 1,
    role: "leader",
    harness: "claude",
    harnessCapabilities: null,
    lastActivityAt: 10,
    ...overrides,
  };
}

afterEach(() => {
  vi.mocked(getProjectSettings).mockReset();
  vi.mocked(updateProjectSettings).mockReset();
  vi.mocked(restartServer).mockReset();
  vi.restoreAllMocks();
});

describe("SettingsScreen", () => {
  it("queries Claude and OpenAI providers for usage reports", async () => {
    vi.mocked(getProjectSettings).mockResolvedValue({});
    const send = vi.fn();
    const subscribers: Array<(msg: ServerMessage) => void> = [];
    const subscribe = vi.fn((_: string | ((msg: ServerMessage) => void), maybeFn?: (msg: ServerMessage) => void) => {
      const fn = typeof _ === "function" ? _ : maybeFn;
      if (fn) subscribers.push(fn);
      return () => {};
    });

    render(
      <HarnessListProvider send={vi.fn()} subscribe={vi.fn()} connected={true}>
        <SettingsScreen
          project={{ id: "proj", name: "Project", path: "/work/app" }}
          sessions={[
            session({ sessionKey: "claude-1", harness: "claude", lastActivityAt: 20 }),
            session({ sessionKey: "codex-1", harness: "codex", lastActivityAt: 30 }),
          ]}
          send={send}
          subscribe={subscribe}
        />
      </HarnessListProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "get_provider_usage_report", harness: "claude" }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "get_provider_usage_report", harness: "codex" }),
    );

    const claudeRequest = send.mock.calls.find(
      ([payload]) => (payload as { harness?: string }).harness === "claude",
    )?.[0] as { requestId: string };

    act(() => {
      subscribers.forEach((fn) =>
        fn({
          type: "control_response",
          command: "get_provider_usage_report",
          sessionKey: "claude-1",
          requestId: claudeRequest.requestId,
          success: true,
          usage: {
            rate_limits_available: true,
            rate_limits: {
              five_hour: {
                utilization: 41.8,
                resets_at: "2026-07-03T16:05:00.000Z",
              },
            },
          },
        }),
      );
    });

    expect(await screen.findByText("42%")).toBeInTheDocument();
    expect(screen.getByText(/Resets/)).toBeInTheDocument();
  });

  it("shows an OpenAI provider unavailable reason", async () => {
    vi.mocked(getProjectSettings).mockResolvedValue({});
    const send = vi.fn();
    const subscribers: Array<(msg: ServerMessage) => void> = [];
    const subscribe = vi.fn((_: string | ((msg: ServerMessage) => void), maybeFn?: (msg: ServerMessage) => void) => {
      const fn = typeof _ === "function" ? _ : maybeFn;
      if (fn) subscribers.push(fn);
      return () => {};
    });

    render(
      <HarnessListProvider send={vi.fn()} subscribe={vi.fn()} connected={true}>
        <SettingsScreen
          project={{ id: "proj", name: "Project", path: "/work/app" }}
          send={send}
          subscribe={subscribe}
        />
      </HarnessListProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    const openaiRequest = send.mock.calls.find(
      ([payload]) => (payload as { harness?: string }).harness === "codex",
    )?.[0] as { requestId: string };

    act(() => {
      subscribers.forEach((fn) =>
        fn({
          type: "control_response",
          command: "get_provider_usage_report",
          sessionKey: null,
          requestId: openaiRequest.requestId,
          success: true,
          provider: "codex",
          usage: {
            rate_limits_available: false,
            rate_limits: null,
            unavailable_reason: "OpenAI/Codex rate-limit reset windows are not exposed.",
          },
        }),
      );
    });

    expect(
      await screen.findByText("OpenAI/Codex rate-limit reset windows are not exposed."),
    ).toBeInTheDocument();
  });
});
