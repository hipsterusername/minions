import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionChatScreen } from "./SessionChatScreen.tsx";
import type { ServerMessage, SocketSubscribe } from "../use-socket.ts";
import type { MobileSessionInfo } from "./mobile-selectors.ts";

function fakeSubscribe(onMessage?: (listener: (msg: ServerMessage) => void) => void): SocketSubscribe {
  return Object.assign(
    ((topicOrFn: string | ((msg: ServerMessage) => void), fn?: (msg: ServerMessage) => void) => {
      const listener = typeof topicOrFn === "function" ? topicOrFn : fn;
      if (listener) onMessage?.(listener);
      return () => {};
    }) as SocketSubscribe,
    { supportsTopics: true as const },
  );
}

function leaderSession(overrides: Partial<MobileSessionInfo> = {}): MobileSessionInfo {
  return {
    sessionKey: "leader-1",
    sessionId: null,
    status: "running",
    cwd: "/work/project",
    role: "leader",
    taskName: "Ship mobile dashboard",
    ...overrides,
  };
}

describe("SessionChatScreen", () => {
  it("syncs the session on mount", async () => {
    const send = vi.fn();
    render(
      <SessionChatScreen
        sessionKey="s-1"
        subscribe={fakeSubscribe()}
        send={send}
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({ type: "sync_session", sessionKey: "s-1" });
    });
  });

  it("sends the typed prompt through the composer", async () => {
    const send = vi.fn();
    render(
      <SessionChatScreen
        sessionKey="s-2"
        subscribe={fakeSubscribe()}
        send={send}
        onBack={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Please focus on tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        type: "send_message",
        sessionKey: "s-2",
        prompt: "Please focus on tests",
      });
    });
  });

  it("keeps the typed prompt visible in the composer before send", () => {
    render(
      <SessionChatScreen
        sessionKey="s-visible"
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    const composer = screen.getByLabelText("Message");
    fireEvent.change(composer, {
      target: { value: "This should stay visible while composing" },
    });

    expect(composer).toHaveValue("This should stay visible while composing");
    expect(screen.getByText("40 chars")).toBeInTheDocument();
  });

  it("sends selected image attachments through the composer", async () => {
    const send = vi.fn();
    render(
      <SessionChatScreen
        sessionKey="s-3"
        subscribe={fakeSubscribe()}
        send={send}
        onBack={() => {}}
      />,
    );

    const fileInput = screen.getByLabelText("File attachments");
    const file = new File(["image-bytes"], "mock.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByLabelText("Attached files")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        type: "send_message",
        sessionKey: "s-3",
        prompt: "",
        attachments: [
          {
            kind: "image",
            filename: "mock.png",
            mediaType: "image/png",
            data: "aW1hZ2UtYnl0ZXM=",
          },
        ],
      });
    });
  });

  it("sends selected text files as prompt context through the composer", async () => {
    const send = vi.fn();
    render(
      <SessionChatScreen
        sessionKey="s-4"
        subscribe={fakeSubscribe()}
        send={send}
        onBack={() => {}}
      />,
    );

    const fileInput = screen.getByLabelText("File attachments");
    const file = new File(["# Spec\nBuild mobile upload."], "spec.md", { type: "text/markdown" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("spec.md")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Use this file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        type: "send_message",
        sessionKey: "s-4",
        prompt: "Use this file\n\nAttached file: spec.md\nMedia type: text/markdown\n```markdown\n# Spec\nBuild mobile upload.\n```",
      });
    });
  });

  it("shows active minions in the leader plan tab", () => {
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          activeMinions: [
            {
              taskId: "api-tests",
              title: "Repair API test coverage",
              status: "running",
              sessionKey: "minion-1",
            },
            {
              taskId: "design-pass",
              title: "Polish dashboard layout",
              status: "blocked",
              sessionKey: "minion-2",
            },
          ],
        })}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /plan/i }));

    const dashboard = screen.getByRole("region", { name: "Active minions" });
    expect(dashboard).toBeInTheDocument();
    expect(screen.getByText("Minion dashboard")).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(within(dashboard).getByText("Repair API test coverage")).toBeInTheDocument();
    expect(within(dashboard).getByText("Polish dashboard layout")).toBeInTheDocument();
    // Counts scoped to the dashboard: the persistent activity strip renders the
    // same summary text, so query within the region to avoid the collision.
    expect(within(dashboard).getByText("1 running")).toBeInTheDocument();
    expect(within(dashboard).getByText("1 blocked")).toBeInTheDocument();
  });

  it("progressively discloses task plan details", () => {
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          taskPlan: [
            {
              taskId: "api-tests",
              title: "Repair API test coverage",
              description: "Run the focused API tests and patch the failing route.",
              priority: "high",
              executor: "minion",
              minionSessionKey: "minion-1",
              status: "running",
              createdAt: 1,
              completedAt: null,
              result: null,
            },
          ],
        })}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /plan/i }));

    expect(screen.getByText("Repair API test coverage")).toBeInTheDocument();
    expect(screen.getByText("Run the focused API tests and patch the failing route.")).not.toBeVisible();

    fireEvent.click(screen.getByText("Repair API test coverage"));

    expect(screen.getByText("Run the focused API tests and patch the failing route.")).toBeVisible();
  });

  it("organizes the leader plan around attention, current work, queue, and finished work", () => {
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          taskPlan: [
            {
              taskId: "blocked-review",
              title: "Resolve design question",
              description: "Wait for user direction on the navigation tradeoff.",
              priority: "critical",
              executor: "leader",
              minionSessionKey: null,
              status: "blocked",
              createdAt: 1,
              completedAt: null,
              result: null,
            },
            {
              taskId: "api-tests",
              title: "Repair API test coverage",
              description: "Run the focused API tests and patch the failing route.",
              priority: "high",
              executor: "minion",
              minionSessionKey: "minion-1",
              status: "running",
              createdAt: 2,
              completedAt: null,
              result: null,
            },
            {
              taskId: "docs",
              title: "Update release notes",
              description: "Summarize the shipped behavior.",
              priority: "low",
              executor: "leader",
              minionSessionKey: null,
              status: "planned",
              createdAt: 3,
              completedAt: null,
              result: null,
            },
            {
              taskId: "lint",
              title: "Run lint",
              description: "Check formatting.",
              priority: "medium",
              executor: "leader",
              minionSessionKey: null,
              status: "completed",
              createdAt: 4,
              completedAt: 5,
              result: "Lint passed.",
            },
          ],
          activeMinions: [
            {
              taskId: "api-tests",
              title: "Repair API test coverage",
              status: "running",
              sessionKey: "minion-1",
            },
          ],
        })}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /plan/i }));

    expect(screen.getByText("1/4 complete")).toBeInTheDocument();
    expect(screen.getByText("1 blocked")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Needs Attention" })).toHaveTextContent("Resolve design question");
    expect(screen.getByRole("region", { name: "In Progress" })).toHaveTextContent("Repair API test coverage");
    expect(screen.getByRole("region", { name: "Up Next" })).toHaveTextContent("Update release notes");
    expect(screen.getByRole("region", { name: "Finished" })).toHaveTextContent("Run lint");
    expect(screen.queryByText("Minion dashboard")).not.toBeInTheDocument();
  });

  it("keeps a live leader activity strip visible across tabs", () => {
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          status: "running",
          lastActivity: "Editing SessionChatScreen.tsx",
          activeMinions: [
            { taskId: "api-tests", title: "Repair API test coverage", status: "running", sessionKey: "minion-1" },
            { taskId: "design", title: "Polish layout", status: "blocked", sessionKey: "minion-2" },
          ],
        })}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    // Visible on the default chat tab...
    const strip = screen.getByRole("region", { name: "Leader activity" });
    expect(within(strip).getByText("running")).toBeInTheDocument();
    expect(within(strip).getByText("1 running")).toBeInTheDocument();
    expect(within(strip).getByText("1 blocked")).toBeInTheDocument();
    expect(within(strip).getByText("Editing SessionChatScreen.tsx")).toBeInTheDocument();

    // ...and still visible after switching to the Plan tab.
    fireEvent.click(screen.getByRole("button", { name: /plan/i }));
    expect(screen.getByRole("region", { name: "Leader activity" })).toBeInTheDocument();
  });

  it("marks the plan tab badge live when work is running", () => {
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          activeMinions: [
            { taskId: "api-tests", title: "Repair API test coverage", status: "running", sessionKey: "minion-1" },
          ],
        })}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    const planTab = screen.getByRole("button", { name: /plan/i });
    expect(planTab.querySelector('span[data-live="true"]')).not.toBeNull();
  });

  it("does not mark the plan tab badge live when nothing is running", () => {
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          activeMinions: [
            { taskId: "docs", title: "Write docs", status: "planned", sessionKey: "minion-1" },
          ],
        })}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    const planTab = screen.getByRole("button", { name: /plan/i });
    expect(planTab.querySelector("span")).not.toBeNull();
    expect(planTab.querySelector('span[data-live="true"]')).toBeNull();
  });

  it("switches to the dashboard tab and renders the session render state", () => {
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          renderState: {
            layout: { title: "Build status", columns: 1 },
            components: [{ id: "status", type: "text", content: "Dashboard online" }],
          },
        })}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /dashboard/i }));

    expect(screen.getByText("Build status")).toBeInTheDocument();
    expect(screen.getByText("Dashboard online")).toBeInTheDocument();
  });
});
