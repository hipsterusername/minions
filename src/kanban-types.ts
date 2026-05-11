export interface KanbanSubtask {
  id: string;
  title: string;
  done: boolean;
}

export type ModelOption = string;
export type PermissionMode = "auto" | "bypassPermissions" | "default" | "plan" | "acceptEdits";

export type BlockReason =
  | "session_lost"
  | "error"
  | "interrupted"
  | "needs_input"
  | "idle_review";

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  subtasks: KanbanSubtask[];
  context: string;
  priority: "low" | "medium" | "high" | "critical";
  columnId: string;
  createdAt: number;
  /** Model to use for the leader session */
  model: ModelOption;
  /** Permission mode for the leader session */
  permissionMode: PermissionMode;
  /** Whether to isolate the leader in a git worktree */
  worktreeIsolation: boolean;
  /** IDs of skills to attach to the leader */
  skillIds: string[];
  /** Variable values for each skill: { [skillId]: { [varName]: value } } */
  skillValues: Record<string, Record<string, string>>;
  /** IDs of canvas context nodes (markdown, file-viewer) linked to this card */
  linkedContextNodeIds: string[];
  /** The canvas node ID of the Leader node working on this card */
  leaderNodeId?: string | undefined;
  /** Summary of the agent's work (filled when moved to history) */
  agentSummary?: string | undefined;
  /** Total cost of the agent session */
  agentCost?: number | undefined;
  /** Archived messages from the leader session (preserved when card moves to history) */
  archivedMessages?: import("./sdk-messages.ts").DisplayMessage[] | undefined;
  /** Archived task plan from the leader session */
  archivedTaskPlan?: import("./nodes/LeaderNode.tsx").TaskPlanItem[] | undefined;
  /** Archived task name set by the agent */
  archivedTaskName?: string | null | undefined;
  /** Archived turn count */
  archivedTurns?: number | undefined;
  /** Why this card is halted (only relevant when columnId === "halted") */
  blockReason?: BlockReason | undefined;
  /** Human-readable detail about the block */
  blockDetail?: string | undefined;
  /** True if this card was auto-created to represent a canvas agent (not manually created from backlog) */
  autoSynced?: boolean | undefined;
  /** Temporary card-composer state while AI Finish is creating or failed to create the card */
  composerState?: "creating" | "error" | undefined;
  /** Session key for the card-composer job backing this temporary card */
  composerSessionKey?: string | undefined;
  /** Human-readable error from the card-composer job */
  composerError?: string | undefined;
}

export interface KanbanColumn {
  id: string;
  title: string;
  color: string;
}

export interface KanbanBoard {
  columns: KanbanColumn[];
  cards: KanbanCard[];
}

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: "backlog", title: "Backlog", color: "#6b7280" },
  { id: "in-progress", title: "In Progress", color: "#f59e0b" },
  { id: "halted", title: "Waiting", color: "#f59e0b" },
  { id: "history", title: "Agent History", color: "#10b981" },
];

export type KanbanAction =
  | { type: "ADD_CARD"; card: KanbanCard }
  | { type: "REMOVE_CARD"; cardId: string }
  | { type: "CLEAR_ARCHIVE" }
  | { type: "UPDATE_CARD"; cardId: string; data: Partial<Omit<KanbanCard, "id">> }
  | { type: "MOVE_CARD"; cardId: string; targetColumnId: string; targetIndex?: number | undefined }
  | { type: "TOGGLE_SUBTASK"; cardId: string; subtaskId: string }
  | { type: "ADD_SUBTASK"; cardId: string; subtask: KanbanSubtask }
  | { type: "REMOVE_SUBTASK"; cardId: string; subtaskId: string }
  | { type: "SET_BOARD"; board: KanbanBoard }
  | { type: "BIND_LEADER"; cardId: string; leaderNodeId: string }
  | { type: "COMPLETE_CARD"; cardId: string; summary?: string | undefined; cost?: number | undefined; archivedMessages?: import("./sdk-messages.ts").DisplayMessage[] | undefined; archivedTaskPlan?: import("./nodes/LeaderNode.tsx").TaskPlanItem[] | undefined; archivedTaskName?: string | null | undefined; archivedTurns?: number | undefined }
  | { type: "BLOCK_CARD"; cardId: string; reason: BlockReason; detail?: string | undefined }
  | { type: "UNBLOCK_CARD"; cardId: string }
  | { type: "HALT_CARD"; cardId: string; reason: BlockReason; detail?: string | undefined }
  | { type: "RESUME_HALTED_CARD"; cardId: string };

export function kanbanReducer(state: KanbanBoard, action: KanbanAction): KanbanBoard {
  switch (action.type) {
    case "ADD_CARD":
      return { ...state, cards: [...state.cards, action.card] };

    case "REMOVE_CARD":
      return { ...state, cards: state.cards.filter((c) => c.id !== action.cardId) };

    case "CLEAR_ARCHIVE":
      return { ...state, cards: state.cards.filter((c) => c.columnId !== "history") };

    case "UPDATE_CARD":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId ? { ...c, ...action.data } : c,
        ),
      };

    case "MOVE_CARD": {
      const card = state.cards.find((c) => c.id === action.cardId);
      if (!card) return state;

      const otherCards = state.cards.filter((c) => c.id !== action.cardId);
      const movedCard = { ...card, columnId: action.targetColumnId };

      if (action.targetIndex !== undefined) {
        // Insert at specific index within the target column
        const before: KanbanCard[] = [];
        const after: KanbanCard[] = [];
        let colIndex = 0;
        for (const c of otherCards) {
          if (c.columnId === action.targetColumnId) {
            if (colIndex < action.targetIndex) {
              before.push(c);
            } else {
              after.push(c);
            }
            colIndex++;
          } else {
            before.push(c);
          }
        }
        // Rebuild: non-target cards + target cards before index + moved card + target cards after index
        const nonTarget = otherCards.filter((c) => c.columnId !== action.targetColumnId);
        const targetCards = otherCards.filter((c) => c.columnId === action.targetColumnId);
        const targetBefore = targetCards.slice(0, action.targetIndex);
        const targetAfter = targetCards.slice(action.targetIndex);
        return { ...state, cards: [...nonTarget, ...targetBefore, movedCard, ...targetAfter] };
      }

      return { ...state, cards: [...otherCards, movedCard] };
    }

    case "TOGGLE_SUBTASK":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? {
                ...c,
                subtasks: c.subtasks.map((s) =>
                  s.id === action.subtaskId ? { ...s, done: !s.done } : s,
                ),
              }
            : c,
        ),
      };

    case "ADD_SUBTASK":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? { ...c, subtasks: [...c.subtasks, action.subtask] }
            : c,
        ),
      };

    case "REMOVE_SUBTASK":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? { ...c, subtasks: c.subtasks.filter((s) => s.id !== action.subtaskId) }
            : c,
        ),
      };

    case "SET_BOARD":
      return action.board;

    case "BIND_LEADER":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? { ...c, leaderNodeId: action.leaderNodeId, columnId: "in-progress" }
            : c,
        ),
      };

    case "COMPLETE_CARD":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? {
                ...c,
                columnId: "history",
                agentSummary: action.summary,
                agentCost: action.cost,
                archivedMessages: action.archivedMessages ?? c.archivedMessages,
                archivedTaskPlan: action.archivedTaskPlan ?? c.archivedTaskPlan,
                archivedTaskName: action.archivedTaskName ?? c.archivedTaskName,
                archivedTurns: action.archivedTurns ?? c.archivedTurns,
                blockReason: undefined,
                blockDetail: undefined,
              }
            : c,
        ),
      };

    case "BLOCK_CARD":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? { ...c, columnId: "halted", blockReason: action.reason, blockDetail: action.detail }
            : c,
        ),
      };

    case "UNBLOCK_CARD":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? { ...c, columnId: "in-progress", blockReason: undefined, blockDetail: undefined }
            : c,
        ),
      };

    case "HALT_CARD":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? { ...c, columnId: "halted", blockReason: action.reason, blockDetail: action.detail }
            : c,
        ),
      };

    case "RESUME_HALTED_CARD":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === action.cardId
            ? { ...c, columnId: "in-progress", blockReason: undefined, blockDetail: undefined }
            : c,
        ),
      };

    default:
      return state;
  }
}
