/**
 * Component tests for `KanbanBoard`.
 *
 * Focused on the user-facing flows that previously had no protection.
 * The "Clear Agent History" suite is the regression test for the bug
 * where the column header's Clear button was wired to an undefined
 * setter (`setConfirmClearArchive`) — clicking it threw a
 * `ReferenceError` and never opened the confirmation modal.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { useReducer } from "react";
import { KanbanBoard } from "./KanbanBoard.tsx";
import {
  kanbanReducer,
  DEFAULT_COLUMNS,
  type KanbanBoard as KanbanBoardType,
  type KanbanCard,
} from "./kanban-types.ts";
import type { CanvasNode } from "./types.ts";
import type { DisplayMessage } from "./sdk-messages.ts";
import type { LeaderData } from "./nodes/LeaderNode.tsx";
import type { RenderState } from "../shared/render-dsl.ts";
import type { ServerMessage } from "./use-socket.ts";

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "c-" + Math.random().toString(36).slice(2, 8),
    title: "Test card",
    description: "",
    subtasks: [],
    context: "",
    priority: "medium",
    columnId: "backlog",
    createdAt: 0,
    model: "sonnet",
    permissionMode: "auto",
    worktreeIsolation: false,
    skillIds: [],
    skillValues: {},
    linkedContextNodeIds: [],
    ...overrides,
  };
}

function makeBoard(cards: KanbanCard[] = []): KanbanBoardType {
  return { columns: DEFAULT_COLUMNS, cards };
}

function makeLeaderNode(sessionKey: string, messages: DisplayMessage[] = []): CanvasNode {
  const leaderData: LeaderData = {
    sessionKey,
    status: "running",
    messages,
    streamingText: "",
    totalCost: 0,
    turns: 0,
    error: null,
    model: "sonnet",
    permissionMode: "auto",
    thinkingConfig: { enabled: false, effort: "low" as const, display: "omitted" as const },
    taskPlan: [],
    worktreeIsolation: false,
    worktreePath: null,
    worktreeBranch: null,
    worktreeStatus: "none",
    skillIds: [],
    skillValues: {},
    skillPanelOpen: false,
  } as LeaderData;
  return {
    id: "leader-" + sessionKey,
    type: "leader",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    data: leaderData as unknown as Record<string, unknown>,
  };
}

function makeRenderNode(leaderSessionKey: string, renderState: RenderState): CanvasNode {
  return {
    id: "render-" + leaderSessionKey,
    type: "render",
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    data: {
      leaderSessionKey,
      leaderId: "leader-" + leaderSessionKey,
      renderState,
    } as unknown as Record<string, unknown>,
  };
}

function makeToolMessage(toolName: string, idSuffix: string): DisplayMessage {
  return {
    id: "msg-tool-" + idSuffix,
    role: "tool",
    content: "",
    timestamp: Date.now(),
    toolName,
  };
}

/**
 * Stateful harness: real reducer + the props the board needs.
 * We stub only the boundaries (socket, callbacks). The internal
 * state machine is exercised end-to-end.
 */
function Harness({
  initial,
  onLaunchLeader = vi.fn(),
  onCloseCard = vi.fn(),
  onResume = vi.fn(),
  onOpenCanvas = vi.fn(),
  nodes = [],
  socketSend = vi.fn(),
  socketSubscribe = (() => () => {}) as {
    (fn: (msg: ServerMessage) => void): () => void;
    (topic: string, fn: (msg: ServerMessage) => void): () => void;
  },
}: {
  initial: KanbanBoardType;
  onLaunchLeader?: (card: KanbanCard) => void;
  onCloseCard?: (card: KanbanCard) => void;
  onResume?: (card: KanbanCard) => void;
  onOpenCanvas?: () => void;
  nodes?: CanvasNode[];
  socketSend?: (data: unknown) => void;
  socketSubscribe?: {
    (fn: (msg: ServerMessage) => void): () => void;
    (topic: string, fn: (msg: ServerMessage) => void): () => void;
  };
}) {
  const [board, dispatch] = useReducer(kanbanReducer, initial);
  return (
    <KanbanBoard
      board={board}
      dispatch={dispatch}
      onLaunchLeader={onLaunchLeader}
      onCloseCard={onCloseCard}
      onResume={onResume}
      leaderStatuses={new Map()}
      socketSend={socketSend}
      socketSubscribe={socketSubscribe}
      projectPath="/tmp/p"
      nodes={nodes}
      onOpenCanvas={onOpenCanvas}
    />
  );
}

describe("KanbanBoard — Clear Agent History (regression)", () => {
  it("hides the Clear button when there are no history cards", () => {
    render(<Harness initial={makeBoard([makeCard({ columnId: "backlog" })])} />);
    expect(screen.queryByRole("button", { name: /^clear$/i })).toBeNull();
  });

  it("shows the Clear button only when history has at least one card", () => {
    render(
      <Harness
        initial={makeBoard([makeCard({ id: "h1", columnId: "history" })])}
      />,
    );
    expect(screen.getByRole("button", { name: /^clear$/i })).toBeInTheDocument();
  });

  it("opens the confirmation modal and clears only history cards on confirm", () => {
    render(
      <Harness
        initial={makeBoard([
          makeCard({ id: "back-1", title: "Backlog one", columnId: "backlog" }),
          makeCard({ id: "live-1", title: "Live one", columnId: "in-progress" }),
          makeCard({ id: "hist-1", title: "Done one", columnId: "history" }),
          makeCard({ id: "hist-2", title: "Done two", columnId: "history" }),
        ])}
      />,
    );

    // Sanity: history cards rendered.
    expect(screen.getByText("Done one")).toBeInTheDocument();
    expect(screen.getByText("Done two")).toBeInTheDocument();

    // Click Clear — this previously threw ReferenceError.
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    // Confirmation prompt is rendered (DeleteConfirm shows the count text).
    expect(screen.getByText(/all 2 history cards/i)).toBeInTheDocument();

    // Confirm — find the destructive confirm button in the modal.
    const confirmBtn = screen.getByRole("button", { name: /delete|confirm|remove/i });
    fireEvent.click(confirmBtn);

    // Both history cards gone, non-history cards still present.
    expect(screen.queryByText("Done one")).toBeNull();
    expect(screen.queryByText("Done two")).toBeNull();
    expect(screen.getByText("Backlog one")).toBeInTheDocument();
    expect(screen.getByText("Live one")).toBeInTheDocument();
  });

  it("cancel leaves history intact", () => {
    render(
      <Harness
        initial={makeBoard([
          makeCard({ id: "hist-1", title: "Done one", columnId: "history" }),
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByText("Done one")).toBeInTheDocument();
    // Modal copy is gone.
    expect(screen.queryByText(/all 1 history card/i)).toBeNull();
  });
});

describe("KanbanBoard — Add card flow", () => {
  it("opens the form, submits a new card, and the card appears in backlog", () => {
    render(<Harness initial={makeBoard()} />);

    fireEvent.click(screen.getByRole("button", { name: /add new card/i }));

    const taskInput = screen.getByLabelText(/agent task/i);
    fireEvent.change(taskInput, { target: { value: "Brand new task" } });

    fireEvent.click(screen.getByRole("button", { name: /create card/i }));

    expect(screen.getByText("Brand new task")).toBeInTheDocument();
  });

  it("disables the submit button when the title is empty", () => {
    render(<Harness initial={makeBoard()} />);

    fireEvent.click(screen.getByRole("button", { name: /add new card/i }));
    const submit = screen.getByRole("button", { name: /create card/i });
    expect(submit).toBeDisabled();
  });

  it("starts a structured card-composer job and adds the returned card", () => {
    const socketSend = vi.fn();
    let subscribedTopic = "";
    let listener: ((msg: ServerMessage) => void) | null = null;
    const socketSubscribe = vi.fn((topicOrFn: string | ((msg: ServerMessage) => void), maybeFn?: (msg: ServerMessage) => void) => {
      if (typeof topicOrFn === "string") {
        subscribedTopic = topicOrFn;
        listener = maybeFn ?? null;
      } else {
        listener = topicOrFn;
      }
      return () => {};
    }) as {
      (fn: (msg: ServerMessage) => void): () => void;
      (topic: string, fn: (msg: ServerMessage) => void): () => void;
    };

    render(
      <Harness
        initial={makeBoard()}
        socketSend={socketSend}
        socketSubscribe={socketSubscribe}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add new card/i }));
    fireEvent.change(screen.getByLabelText(/agent task/i), {
      target: { value: "Make the settings page easier to scan" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ai finish/i }));

    expect(screen.getByText("Make the settings page easier to scan")).toBeInTheDocument();
    expect(screen.getByText("Creating...")).toBeInTheDocument();
    expect(screen.getByText("Creating card...")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add new card/i }));
    expect(screen.getByLabelText(/agent task/i)).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /cancel adding card/i }));

    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create_session",
        role: "card-composer",
        permissionMode: "plan",
        worktreeIsolation: false,
      }),
    );
    const startCommand = socketSend.mock.calls[0]?.[0] as { sessionKey: string };
    expect(subscribedTopic).toBe(`session:${startCommand.sessionKey}`);

    act(() => {
      listener?.({
        type: "kanban_card_created",
        sessionKey: startCommand.sessionKey,
        timestamp: Date.now(),
        card: {
          title: "Improve settings scanability",
          description: "Make the settings page easier to scan.",
          context: "Group related controls and tighten labels.",
          priority: "medium",
          subtasks: ["Group controls", "Clarify labels"],
        },
      });
    });

    expect(screen.getByText("Improve settings scanability")).toBeInTheDocument();
    expect(screen.queryByText("Creating...")).toBeNull();
    expect(socketSend).toHaveBeenCalledWith({
      type: "close_session",
      sessionKey: startCommand.sessionKey,
    });
  });
});

describe("KanbanBoard — Launch leader", () => {
  it("invokes onLaunchLeader with the card when the Launch button is clicked", () => {
    const onLaunchLeader = vi.fn();
    const card = makeCard({ id: "to-launch", title: "Launch me", columnId: "backlog" });
    render(<Harness initial={makeBoard([card])} onLaunchLeader={onLaunchLeader} />);

    // Expand the card body to reveal Launch.
    fireEvent.click(screen.getByText("Launch me"));

    fireEvent.click(screen.getByRole("button", { name: /launch launch me/i }));
    expect(onLaunchLeader).toHaveBeenCalledTimes(1);
    expect(onLaunchLeader.mock.calls[0]?.[0]?.id).toBe("to-launch");
  });
});

describe("KanbanBoard — column counts", () => {
  it("shows totals reflecting the current board state", () => {
    render(
      <Harness
        initial={makeBoard([
          makeCard({ columnId: "backlog" }),
          makeCard({ columnId: "backlog" }),
          makeCard({ columnId: "in-progress" }),
          makeCard({ columnId: "history" }),
        ])}
      />,
    );

    // Toolbar shows total non-history task count (3).
    expect(screen.getByText(/3 tasks/i)).toBeInTheDocument();

    // Each column header shows its own count — find via column section.
    const backlogSection = screen.getByLabelText(/backlog column/i);
    expect(within(backlogSection).getByLabelText(/2 cards/i)).toBeInTheDocument();
    const inProgressSection = screen.getByLabelText(/in progress column/i);
    expect(within(inProgressSection).getByLabelText(/1 cards/i)).toBeInTheDocument();
    const historySection = screen.getByLabelText(/agent history column/i);
    expect(within(historySection).getByLabelText(/1 cards/i)).toBeInTheDocument();
  });
});

describe("KanbanBoard inspector — chat tool filtering", () => {
  it("hides pure-orchestration tool calls (set_task_name, render_*, etc.)", () => {
    const sk = "sess-1";
    const messages: DisplayMessage[] = [
      makeToolMessage("set_task_name", "1"),
      makeToolMessage("mcp__task-manager__set_task_name", "2"),
      makeToolMessage("render_set", "3"),
      makeToolMessage("mcp__render-dashboard__render_patch", "4"),
      makeToolMessage("get_task_status", "5"),
      makeToolMessage("wait_and_continue", "6"),
      makeToolMessage("TodoWrite", "7"),
    ];
    const card = makeCard({
      id: "card-1",
      title: "Live card",
      columnId: "in-progress",
      leaderNodeId: "leader-" + sk,
    });
    render(
      <Harness initial={makeBoard([card])} nodes={[makeLeaderNode(sk, messages)]} />,
    );

    fireEvent.click(screen.getByText("Live card"));

    // Activity tab is the default for non-backlog cards. None of the hidden
    // tool names should appear anywhere in the chat surface.
    expect(screen.queryByText("set_task_name")).toBeNull();
    expect(screen.queryByText("render_set")).toBeNull();
    expect(screen.queryByText("render_patch")).toBeNull();
    expect(screen.queryByText("get_task_status")).toBeNull();
    expect(screen.queryByText("wait_and_continue")).toBeNull();
    expect(screen.queryByText("TodoWrite")).toBeNull();

    // With every tool hidden, the chat shows the empty state.
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("groups consecutive visible tool calls into a single pill with a count", () => {
    const sk = "sess-2";
    const messages: DisplayMessage[] = [
      makeToolMessage("Read", "1"),
      makeToolMessage("Read", "2"),
      makeToolMessage("Edit", "3"),
      makeToolMessage("Bash", "4"),
      // hidden — must not break the run
      makeToolMessage("set_task_name", "5"),
      makeToolMessage("Grep", "6"),
    ];
    const card = makeCard({
      id: "card-2",
      title: "Group card",
      columnId: "in-progress",
      leaderNodeId: "leader-" + sk,
    });
    render(
      <Harness initial={makeBoard([card])} nodes={[makeLeaderNode(sk, messages)]} />,
    );

    fireEvent.click(screen.getByText("Group card"));

    // Single grouped button summarises the unique tool names.
    const groupBtn = screen.getByRole("button", { name: /5 tool calls/i });
    expect(groupBtn).toBeInTheDocument();
    expect(groupBtn).toHaveAttribute("aria-expanded", "false");

    // Expanding reveals the per-call list (5 entries, hidden tool excluded).
    fireEvent.click(groupBtn);
    expect(groupBtn).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
  });
});

describe("KanbanBoard inspector — Dashboard tab", () => {
  it("shows a Dashboard tab and renders the paired RenderNode's components", () => {
    const sk = "sess-dash-1";
    const renderState: RenderState = {
      layout: { columns: 2, gap: 12 },
      components: [
        {
          id: "m1",
          type: "metric",
          label: "Tests passing",
          value: "835",
          color: "green",
        },
      ],
    };
    const card = makeCard({
      id: "card-dash",
      title: "Dash card",
      columnId: "in-progress",
      leaderNodeId: "leader-" + sk,
    });
    render(
      <Harness
        initial={makeBoard([card])}
        nodes={[makeLeaderNode(sk), makeRenderNode(sk, renderState)]}
      />,
    );

    fireEvent.click(screen.getByText("Dash card"));

    // Dashboard tab is present.
    const dashboardTab = screen.getByRole("button", { name: /^dashboard$/i });
    expect(dashboardTab).toBeInTheDocument();

    fireEvent.click(dashboardTab);

    // The metric component bubbles into the inspector.
    expect(screen.getByText("Tests passing")).toBeInTheDocument();
    expect(screen.getByText("835")).toBeInTheDocument();
  });

  it("shows an empty state when no paired RenderNode exists", () => {
    const sk = "sess-dash-2";
    const card = makeCard({
      id: "card-empty",
      title: "Empty dash",
      columnId: "in-progress",
      leaderNodeId: "leader-" + sk,
    });
    render(
      <Harness initial={makeBoard([card])} nodes={[makeLeaderNode(sk)]} />,
    );

    fireEvent.click(screen.getByText("Empty dash"));
    fireEvent.click(screen.getByRole("button", { name: /^dashboard$/i }));

    expect(screen.getByText(/no dashboard yet/i)).toBeInTheDocument();
  });
});

/**
 * The bug was: the inspector's read-only config view rendered subtasks
 * as toggle-only labels, with no add/remove. After the polish pass the
 * subtask editor is the same component regardless of column, so callers
 * can manage the list from any state. These tests pin that behaviour
 * down end-to-end through the reducer.
 */
describe("KanbanBoard — inspector subtask editor", () => {
  it("adds a subtask from the inspector for an in-progress card", () => {
    const sk = "sess-sub-1";
    const card = makeCard({
      id: "c-sub",
      title: "Has subtasks",
      columnId: "in-progress",
      leaderNodeId: "leader-" + sk,
      subtasks: [{ id: "s1", title: "Existing", done: false }],
    });
    render(<Harness initial={makeBoard([card])} nodes={[makeLeaderNode(sk)]} />);
    fireEvent.click(screen.getByText("Has subtasks"));
    fireEvent.click(screen.getByRole("button", { name: /^config$/i }));

    const input = screen.getByLabelText(/new subtask/i);
    fireEvent.change(input, { target: { value: "Fresh subtask" } });
    fireEvent.click(screen.getByRole("button", { name: /add subtask/i }));

    expect(screen.getAllByText("Fresh subtask").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Existing").length).toBeGreaterThan(0);
  });

  it("removes a subtask from the inspector", () => {
    const sk = "sess-sub-2";
    const card = makeCard({
      id: "c-rm",
      title: "Removable",
      columnId: "in-progress",
      leaderNodeId: "leader-" + sk,
      subtasks: [
        { id: "s-keep", title: "Keep me", done: false },
        { id: "s-drop", title: "Drop me", done: false },
      ],
    });
    render(<Harness initial={makeBoard([card])} nodes={[makeLeaderNode(sk)]} />);
    fireEvent.click(screen.getByText("Removable"));
    fireEvent.click(screen.getByRole("button", { name: /^config$/i }));

    fireEvent.click(screen.getByRole("button", { name: /remove subtask: drop me/i }));

    expect(screen.queryByText("Drop me")).toBeNull();
    expect(screen.getAllByText("Keep me").length).toBeGreaterThan(0);
  });

  it("toggles a subtask's done state", () => {
    const sk = "sess-sub-3";
    const card = makeCard({
      id: "c-toggle",
      title: "Toggleable",
      columnId: "in-progress",
      leaderNodeId: "leader-" + sk,
      subtasks: [{ id: "s-t", title: "Check me", done: false }],
    });
    render(<Harness initial={makeBoard([card])} nodes={[makeLeaderNode(sk)]} />);
    fireEvent.click(screen.getByText("Toggleable"));
    fireEvent.click(screen.getByRole("button", { name: /^config$/i }));

    const checkbox = screen.getByRole("checkbox", { name: /check me/i });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});

describe("KanbanBoard — inspector save feedback", () => {
  it("flashes a Saved state on the CardForm submit after saving a backlog card", () => {
    const card = makeCard({ id: "c-save", title: "Edit me", columnId: "backlog" });
    render(<Harness initial={makeBoard([card])} />);

    fireEvent.click(screen.getByText("Edit me"));
    // Config tab is the default for backlog cards.
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(saveBtn);

    // Button label transitions to "Saved" in the same render pass.
    expect(screen.getByRole("button", { name: /^saved$/i })).toBeInTheDocument();
  });
});

describe("KanbanBoard empty state", () => {
  it("offers Kanban and Canvas starting points", () => {
    const onOpenCanvas = vi.fn();
    render(<Harness initial={makeBoard()} onOpenCanvas={onOpenCanvas} />);

    expect(screen.getByRole("button", { name: /create task card/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open canvas/i }));

    expect(onOpenCanvas).toHaveBeenCalledTimes(1);
  });
});
