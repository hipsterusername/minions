import type { AgentTypeContext } from "./types.ts";
import type { TaskManagerState } from "../task-tools.ts";
import type { RenderState } from "../render-tools.ts";
import { persistRenderState, persistTaskState } from "../session-persist.ts";

export function createLeaderStateCallbacks(ctx: AgentTypeContext, sessionKey: string) {
  return {
    onTaskStateChange(state: TaskManagerState): void {
      persistTaskState(sessionKey, state);
      if (state.approval?.requested) {
        ctx.markDecisionNeeded?.(state.approval.summary || "Review and approve changes");
      }
    },
    onRenderStateChange(state: RenderState): void {
      persistRenderState(sessionKey, state);
      ctx.markDashboardChanged?.();
      if (state.components.some((component) => component.type === "form")) {
        ctx.markDecisionNeeded?.("Dashboard input requested");
      }
    },
  };
}
