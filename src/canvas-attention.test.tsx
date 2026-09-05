import { describe, expect, it } from "vitest";
import { canvasAttentionItems } from "./canvas-attention.ts";
import type { MobileSessionInfo } from "./mobile/mobile-selectors.ts";
import type { CanvasNode } from "./types.ts";

function session(sessionKey: string, extra: Partial<MobileSessionInfo> = {}): MobileSessionInfo {
  return { sessionKey, sessionId: null, cwd: "/tmp/project", role: "leader", status: "idle", taskName: sessionKey, ...extra };
}
const lifecycle = { reviewState: "completion_to_review" as const, reviewReason: null, finalReport: null, finalDashboardRevision: null, dashboardRevision: 0, terminalReason: null, terminalAt: 1, acknowledgedAt: null, dismissedAt: null, lifecycleRevision: 1 };
function node(id: string, data: Record<string, unknown>): CanvasNode {
  return { id, type: "leader", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data };
}

describe("Canvas attention destinations", () => {
  it("includes errors and waiting work, excludes ordinary activity and delegated sessions", () => {
    const items = canvasAttentionItems([
      session("idle"), session("running", { status: "running" }),
      session("error", { status: "error" }), session("question", { pendingAttention: true }),
      session("child", { status: "error", role: "minion" }),
    ], [node("error-node", { sessionKey: "error" })]);
    expect(items.map(item => item.title).sort()).toEqual(["error", "question"]);
    expect(items.find(item => item.title === "error")?.nodeId).toBe("error-node");
    expect(items.find(item => item.title === "question")?.nodeId).toBeNull();
    expect(items.find(item => item.title === "question")?.reason).toBe("waiting for you");
  });
  it("honors reviewed and dismissed lifecycle state and keeps fresh decisions first", () => {
    const items = canvasAttentionItems([
      session("report", { reviewLifecycle: lifecycle }),
      session("reviewed", { reviewLifecycle: { ...lifecycle, acknowledgedAt: 2 } }),
      session("dismissed", { status: "error", reviewLifecycle: { ...lifecycle, dismissedAt: 2 } }),
      session("decision", { reviewLifecycle: { ...lifecycle, reviewState: "decision_needed" } }),
    ], []);
    expect(items.map(item => item.title)).toEqual(["decision", "report"]);
  });
  it("resolves a canonical work item after its session key changes", () => {
    const items = canvasAttentionItems([session("new-run", { workItemId: "work-1", status: "waiting" })], [node("leader", { workItemId: "work-1", sessionKey: "old-run" })]);
    expect(items[0]?.nodeId).toBe("leader");
  });
  it("includes reviewable canvas changes using the existing worktree predicate", () => {
    const items = canvasAttentionItems([session("changes")], [node("leader", { sessionKey: "changes", worktreeIsolation: true, approvalPending: true })]);
    expect(items[0]?.reason).toBe("changes ready");
  });
});
