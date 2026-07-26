import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ActiveThinkingIndicator,
  ActivityMessageGroup,
  MessageBubble,
  SessionChatScreen,
  groupMobileMessages,
  mobileDashboardColumns,
} from "./SessionChatScreen.tsx";
import type { DisplayMessage } from "../sdk-messages.ts";
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
  it("shows an accessible pulsing affordance while the agent is thinking", () => {
    render(<ActiveThinkingIndicator />);

    const indicator = screen.getByRole("status");
    expect(indicator).toHaveTextContent("Thinking…");
    expect(indicator.querySelector(".mob-thinking-indicator-dot")).toBeInTheDocument();
  });

  it("collapses auxiliary messages by default and expands their full body", () => {
    const message: DisplayMessage = {
      id: "thinking-1",
      role: "thinking",
      content: "First part followed by the complete and much longer body",
      timestamp: 1,
    };

    render(<MessageBubble message={message} />);

    const row = screen.getByRole("button", { name: "Expand thinking" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row.closest("article")).toHaveAttribute("data-expanded", "false");

    fireEvent.click(row);

    expect(screen.getByRole("button", { name: "Collapse thinking" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("reveals complete tool input when a compact tool row is expanded", () => {
    const message: DisplayMessage = {
      id: "tool-1",
      role: "tool",
      content: "Bash",
      timestamp: 1,
      toolName: "Bash",
      toolInput: { command: "pnpm test -- --runInBand", timeout: 120_000 },
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("pnpm test -- --runInBand")).toBeInTheDocument();
    expect(screen.queryByText(/timeout: 120000/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Run command" }));

    expect(screen.getByText(/command: pnpm test -- --runInBand/)).toBeInTheDocument();
    expect(screen.getByText(/timeout: 120000/)).toBeInTheDocument();
  });

  it("consolidates consecutive auxiliary events into one activity affordance", () => {
    const messages: DisplayMessage[] = [
      { id: "tool-1", role: "tool", content: "Read", timestamp: 1, toolName: "Read", toolInput: { file_path: "src/app.ts" } },
      { id: "thinking-1", role: "thinking", content: "Checking how the pieces fit together", timestamp: 2 },
      { id: "tool-2", role: "tool", content: "Grep", timestamp: 3, toolName: "Grep", toolInput: { pattern: "render" } },
    ];

    expect(groupMobileMessages(messages)).toHaveLength(1);
    render(<ActivityMessageGroup messages={messages} />);

    const toggle = screen.getByRole("button", { name: /Agent activity/ });
    expect(toggle).toHaveTextContent("2 tool calls · 1 progress update");
    expect(toggle).toHaveTextContent("Show details");
    expect(screen.queryByText(/file_path: src\/app.ts/)).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: /Agent activity/ })).toHaveTextContent("Hide details");
    expect(screen.getByText(/file_path: src\/app.ts/)).toBeInTheDocument();
    expect(screen.getByText("Checking how the pieces fit together")).toBeInTheDocument();
  });

  it("shows launch activity while connecting, then while the leader is thinking", () => {
    const props = {
      sessionKey: "leader-launching",
      subscribe: fakeSubscribe(),
      send: vi.fn(),
      onBack: () => {},
    };
    const { rerender } = render(<SessionChatScreen {...props} />);

    expect(screen.getByRole("status")).toHaveTextContent("Connecting to leader…");
    expect(screen.queryByText("No messages yet.")).not.toBeInTheDocument();

    rerender(<SessionChatScreen {...props} session={leaderSession({ status: "running" })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Leader is thinking…");
    expect(screen.getByRole("status").querySelectorAll(".mob-chat-activity-dots i")).toHaveLength(3);
  });

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

  it("switches between project conversations, including minions", () => {
    const onSelectSession = vi.fn();
    const leader = leaderSession();
    const minion = leaderSession({
      sessionKey: "minion-1",
      role: "minion",
      taskName: "Audit touch targets",
    });

    render(
      <SessionChatScreen
        sessionKey={leader.sessionKey}
        session={leader}
        sessionOptions={[leader, minion]}
        subscribe={fakeSubscribe()}
        send={vi.fn()}
        onBack={() => {}}
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Switch session" }), {
      target: { value: "minion-1" },
    });

    expect(onSelectSession).toHaveBeenCalledWith("minion-1");
  });

  it("enables Stop for every retained session until it is stopped", () => {
    const props = {
      sessionKey: "leader-1",
      subscribe: fakeSubscribe(),
      send: vi.fn(),
      onBack: () => {},
    };
    const { rerender } = render(
      <SessionChatScreen {...props} session={leaderSession({ status: "idle" })} />,
    );

    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    rerender(<SessionChatScreen {...props} session={leaderSession({ status: "error" })} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    rerender(<SessionChatScreen {...props} session={leaderSession({ status: "completed" })} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    rerender(<SessionChatScreen {...props} session={leaderSession({ status: "stopped" })} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
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
            layout: { title: "Build status", columns: 3 },
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
    expect(mobileDashboardColumns()).toBe(1);
  });

  it("submits a dashboard form with the server's wire keys", () => {
    // Regression: the mobile onSubmitForm callback previously sent
    // `componentId`/`answers`, but server/commands/submit-form.ts reads
    // `formComponentId`/`formAnswers`, so submissions silently no-opped and the
    // agent never resumed.
    const send = vi.fn();
    render(
      <SessionChatScreen
        sessionKey="leader-1"
        session={leaderSession({
          renderState: {
            layout: { title: "Deploy", columns: 1 },
            components: [{
              id: "deploy-form",
              type: "form",
              fields: [{ id: "note", kind: "text", label: "Note" }],
            }],
          },
        })}
        subscribe={fakeSubscribe()}
        send={send}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /dashboard/i }));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "submit_form",
      sessionKey: "leader-1",
      formComponentId: "deploy-form",
    }));
    const payload = send.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload).toHaveProperty("formAnswers");
    expect(payload).not.toHaveProperty("componentId");
    expect(payload).not.toHaveProperty("answers");
  });
});
