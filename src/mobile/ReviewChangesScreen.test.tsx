import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerMessage, SocketSubscribe } from "../use-socket.ts";
import type { WorktreeLineageSnapshot } from "../../shared/worktree-integration.ts";
import { ReviewChangesScreen } from "./ReviewChangesScreen.tsx";
import type { DetailedDiff } from "./mobile-approvals.ts";

type ServerListener = (msg: ServerMessage) => void;

const requestId = "00000000-0000-4000-8000-000000000001";

const diff: DetailedDiff = {
  filesChanged: 2,
  insertions: 18,
  deletions: 4,
  files: [
    { file: "src/auth/token.ts", insertions: 10, deletions: 4, status: "modified" },
    { file: "src/auth/token.test.ts", insertions: 8, deletions: 0, status: "added" },
  ],
  commits: ["Extract token validation", "Add token tests"],
  branch: "worktree/s-1",
};

function lineageSnapshot(): WorktreeLineageSnapshot {
  return {
    id: "lineage-mobile-01", projectId: "project-1", repositoryPath: "/repo", targetRef: "main",
    baseSha: "base", integrationRef: "refs/minions/integration/1",
    integrationWorktreePath: "/repo/.worktrees/integration", integrationHeadSha: "head",
    revision: 3, integrationState: "active", status: "open",
    memberships: [{ workItemId: "work-1", status: "active", revision: 1, actor: "user",
      joinedAt: 1, leftAt: null }],
    resolutionRuns: [],
    contributions: [{ id: "contrib-1", lineageId: "lineage-mobile-01", workItemId: "work-1",
      originatingRunKey: "s-1", runKeys: ["s-1"], branchName: "feature",
      worktreePath: "/repo/.worktrees/feature", baseSha: "base", headSha: "head",
      revision: 2, state: "ready", reviewState: "pending", cleanupState: "retained",
      createdAt: 1, updatedAt: 2 }],
    queue: [], gates: [], reviews: [], createdAt: 1, updatedAt: 3,
  };
}

function fakeSocket() {
  const listeners = new Set<ServerListener>();
  const subscribe = Object.assign(
    ((topicOrFn: string | ServerListener, fn?: ServerListener) => {
      const listener = typeof topicOrFn === "function" ? topicOrFn : fn;
      if (!listener) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }) as SocketSubscribe,
    { supportsTopics: true as const },
  );

  return {
    subscribe,
    deliver(msg: ServerMessage) {
      for (const listener of listeners) listener(msg);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReviewChangesScreen", () => {
  it("requests the worktree diff on mount", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();
    const send = vi.fn();

    render(
      <ReviewChangesScreen
        sessionKey="s-1"
        send={send}
        subscribe={socket.subscribe}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        type: "get_worktree_diff",
        sessionKey: "s-1",
        requestId,
      });
    });
  });

  it("renders matching diff responses", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();

    render(
      <ReviewChangesScreen
        sessionKey="s-1"
        send={() => {}}
        subscribe={socket.subscribe}
        onClose={() => {}}
        summary="Extracted validation."
      />,
    );

    socket.deliver({
      type: "control_response",
      command: "get_worktree_diff",
      sessionKey: "s-1",
      requestId,
      success: true,
      diff,
    });

    await waitFor(() => {
      expect(screen.getByText("src/auth/token.ts")).toBeInTheDocument();
    });
    expect(screen.getByText("+10 -4")).toBeInTheDocument();
    expect(screen.getByText("Extract token validation")).toBeInTheDocument();
    expect(screen.getByText(/2 files \+18 -4/)).toBeInTheDocument();
  });

  it("sends approve, request-changes, and discard commands", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();
    const send = vi.fn();

    render(
      <ReviewChangesScreen
        sessionKey="s-1"
        send={send}
        subscribe={socket.subscribe}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Merge" }));
    expect(send).toHaveBeenCalledWith({ type: "approve_changes", sessionKey: "s-1" });

    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.change(screen.getByLabelText("Request changes"), {
      target: { value: "Please add coverage for errors." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith({
      type: "send_message",
      sessionKey: "s-1",
      prompt: "Please add coverage for errors.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(screen.getByRole("group", { name: "Confirm discard" })).toBeInTheDocument();
    });
    const confirm = screen.getByRole("group", { name: "Confirm discard" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Discard" }));
    expect(send).toHaveBeenCalledWith({ type: "discard_worktree", sessionKey: "s-1" });
  });

  it("does not expose legacy merge or discard commands for a canonical work item", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();
    const send = vi.fn();
    render(<ReviewChangesScreen sessionKey="s-1" workItemId="work-1" changeMode="worktree" send={send}
      subscribe={socket.subscribe} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Approve & Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "approve_changes" }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "discard_worktree" }));
  });

  it("surfaces the lineage strip and expands the modal with the all-lineages view", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();
    const send = vi.fn();
    render(<ReviewChangesScreen sessionKey="s-1" workItemId="work-1" changeMode="worktree" send={send}
      subscribe={socket.subscribe} onClose={() => {}} />);

    act(() => socket.deliver({ type: "worktree_integration_response",
      command: "get_worktree_lineage_status", requestId: null, success: true,
      result: lineageSnapshot() }));

    // View 1 strip renders inside the mobile Integration section.
    const integration = screen.getByRole("region", { name: "Worktree integration" });
    expect(within(integration).getByTestId("lineage-node-strip")).toBeInTheDocument();

    // Expanding surfaces the new modal with both the this-lineage detail and the
    // all-lineages big-picture capability (the request that fetches them fires).
    fireEvent.click(screen.getByRole("button", { name: "Expand lineage" }));
    expect(screen.getByRole("button", { name: /This lineage/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All lineages/ })).toBeInTheDocument();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "list_worktree_lineages" }));
  });

  it("starts a canonical iteration when requesting changes", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();
    const send = vi.fn();
    const onRequestChanges = vi.fn(() => true);
    render(<ReviewChangesScreen sessionKey="s-1" workItemId="work-1" changeMode="worktree" send={send}
      subscribe={socket.subscribe} onClose={() => {}} onRequestChanges={onRequestChanges} />);
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.change(screen.getByLabelText("Request changes"), { target: { value: "Resolve conflicts." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onRequestChanges).toHaveBeenCalledWith("Resolve conflicts.");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_message" }));
  });

  it("preserves canonical feedback while work item details are loading", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();
    const onClose = vi.fn();
    render(<ReviewChangesScreen sessionKey="s-1" workItemId="work-1" changeMode="worktree" send={vi.fn()}
      subscribe={socket.subscribe} onClose={onClose} onRequestChanges={() => false} />);
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.change(screen.getByLabelText("Request changes"), { target: { value: "Keep this text." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("alert")).toHaveTextContent("feedback has been preserved");
    expect(screen.getByLabelText("Request changes")).toHaveValue("Keep this text.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not expose lineage or approval actions for a live work item", () => {
    const socket = fakeSocket();
    const send = vi.fn();
    render(<ReviewChangesScreen sessionKey="s-1" workItemId="work-1" changeMode="live"
      send={send} subscribe={socket.subscribe} onClose={() => {}} />);
    expect(screen.getByRole("main", { name: "Live changes" })).toHaveTextContent(
      "Live changes are applied directly",
    );
    expect(screen.queryByTestId("worktree-integration-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve & Merge" })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("reveals conflict resolution actions after merge failure", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const socket = fakeSocket();
    const send = vi.fn();

    render(
      <ReviewChangesScreen
        sessionKey="s-1"
        send={send}
        subscribe={socket.subscribe}
        onClose={() => {}}
      />,
    );

    socket.deliver({
      type: "worktree_merge_failed",
      sessionKey: "s-1",
      result: {
        conflicts: ["src/auth/token.ts"],
        summary: "Conflicts while merging",
        targetBranch: "main",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Conflicts while merging")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Force" }));
    fireEvent.click(screen.getByRole("button", { name: "Theirs" }));

    expect(send).toHaveBeenCalledWith({ type: "retry_merge", sessionKey: "s-1" });
    expect(send).toHaveBeenCalledWith({ type: "force_merge", sessionKey: "s-1" });
    expect(send).toHaveBeenCalledWith({ type: "theirs_merge", sessionKey: "s-1" });
  });
});
