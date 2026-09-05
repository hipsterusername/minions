/** Tags describe why context is supplied, never whether orchestration was lost. */
export type RecoveryKind = "proactive" | "context_recovery" | "client_history";
export interface RecoveryFacts {
  providerThread: "fresh_requested" | "unknown";
  taskRegistry: "available_at_capture" | "unknown";
  dashboard: "available_at_capture" | "unknown";
  worktree: "recorded_at_capture" | "none_recorded" | "unknown";
}
export function recoveryTag(kind: RecoveryKind): string {
  return kind === "context_recovery" ? "context-window-recovery" : "session-continuation";
}
export function renderRecoveryFacts(facts: RecoveryFacts): string {
  return ["<retained-state>", ...Object.entries(facts).map(([key, value]) => `${key}: ${value}`),
    "</retained-state>",
    "Continue the logical objective and preserve completed work. Inspect current registry/dashboard state; reconstruct only entries proven missing. A fresh provider thread does not imply orchestration state was lost.",
    "Capture-time records are not proof of current file state. User instructions and current runtime state govern; model summaries, conclusions and proposed next actions are supplemental and may be stale.",
  ].join("\n");
}
