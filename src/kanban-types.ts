export interface KanbanSubtask {
  id: string;
  title: string;
  done: boolean;
}

export type ModelOption = "sonnet" | "opus" | "haiku";
export type PermissionMode = "bypassPermissions" | "default" | "plan" | "acceptEdits";

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
  /** The canvas node ID of the Leader node working on this card */
  leaderNodeId?: string;
  /** Summary of the agent's work (filled when moved to history) */
  agentSummary?: string;
  /** Total cost of the agent session */
  agentCost?: number;
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
  { id: "review", title: "Ready for Review", color: "#3b82f6" },
  { id: "history", title: "Agent History", color: "#8b5cf6" },
];

export type KanbanAction =
  | { type: "ADD_CARD"; card: KanbanCard }
  | { type: "REMOVE_CARD"; cardId: string }
  | { type: "UPDATE_CARD"; cardId: string; data: Partial<Omit<KanbanCard, "id">> }
  | { type: "MOVE_CARD"; cardId: string; targetColumnId: string; targetIndex?: number }
  | { type: "TOGGLE_SUBTASK"; cardId: string; subtaskId: string }
  | { type: "ADD_SUBTASK"; cardId: string; subtask: KanbanSubtask }
  | { type: "REMOVE_SUBTASK"; cardId: string; subtaskId: string }
  | { type: "SET_BOARD"; board: KanbanBoard }
  | { type: "BIND_LEADER"; cardId: string; leaderNodeId: string }
  | { type: "COMPLETE_CARD"; cardId: string; summary?: string; cost?: number };

export function kanbanReducer(state: KanbanBoard, action: KanbanAction): KanbanBoard {
  switch (action.type) {
    case "ADD_CARD":
      return { ...state, cards: [...state.cards, action.card] };

    case "REMOVE_CARD":
      return { ...state, cards: state.cards.filter((c) => c.id !== action.cardId) };

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
            ? { ...c, columnId: "history", agentSummary: action.summary, agentCost: action.cost }
            : c,
        ),
      };

    default:
      return state;
  }
}
