import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitContextCheckpoint,
  compileContextCheckpoint,
  checkpointStartOptions,
  renderCheckpointPrompt,
  validateCheckpoint,
} from "./context-checkpoint.ts";
import type { SessionHost } from "./session-host.ts";
import { closePersistDb, openPersistDb } from "./session-persist.ts";

function host(): SessionHost {
  return {
    id: "leader-1", sessionId: "provider-old", taskName: "Build continuity", cwd: "/repo",
    taskState: { tasks: new Map([
      ["done", { taskId: "done", title: "Inspect architecture", description: "", priority: "high", executor: "leader", minionSessionKey: null, leaderSessionKey: "leader-1", status: "completed", createdAt: 1, completedAt: 2, result: "Tests passed", files: ["server/a.ts"], constraints: ["Preserve task IDs"], acceptanceCriteria: ["State survives a swap"] }],
      ["next", { taskId: "next", title: "Wire recovery", description: "", priority: "high", executor: "leader", minionSessionKey: null, leaderSessionKey: "leader-1", status: "running", createdAt: 3, completedAt: null, result: null }],
    ]), pendingWait: null, approval: null },
    renderState: { layout: { title: "Continuity", columns: 2, gap: 12 }, components: [{ id: "tests", type: "status", label: "Tests", state: "running" }] },
    worktree: { path: "/repo/wt", branch: "minions/continuity", projectPath: "/repo", createdAt: 1, lifecycle: "active" },
    eventBuffer: [{ type: "sdk_event", sessionKey: "leader-1", event: { kind: "text", role: "assistant", text: "Found the insertion point." }, timestamp: 1 }],
  } as unknown as SessionHost;
}

beforeEach(() => openPersistDb(":memory:"));
afterEach(() => closePersistDb());

describe("context checkpoint compiler", () => {
  it("combines authoritative state with structured semantic state", () => {
    const checkpoint = compileContextCheckpoint(host(), {
      trigger: "proactive", originalPrompt: "Build a durable continuity subsystem.",
      modelHandoff: ["Goal: Preserve the active objective", "Decisions:", "- Use one compiler because both paths need identical semantics", "Dead ends:", "- Do not replay the entire transcript", "Open questions:", "- Whether provider metadata exposes exact limits", "Next actions:", "- Run continuity tests"].join("\n"),
    });
    expect(checkpoint.objective.statement).toBe("Build a durable continuity subsystem.");
    expect(checkpoint.modelHandoff).toContain("Preserve the active objective");
    expect(checkpoint.progress.completed[0]?.taskId).toBe("done");
    expect(checkpoint.progress.inProgress[0]?.taskId).toBe("next");
    expect(checkpoint.constraints).toContain("Preserve task IDs");
    expect(checkpoint.negativeKnowledge).toContain("Do not replay the entire transcript");
    expect(checkpoint.nextActions).toEqual(["Run continuity tests"]);
    expect(checkpoint.activeArtifacts).toContainEqual({ kind: "file", ref: "server/a.ts" });
    expect(renderCheckpointPrompt(checkpoint)).toContain("State survives a swap");
  });

  it("persists prepare and commit transaction states", () => {
    const db = openPersistDb();
    const checkpoint = compileContextCheckpoint(host(), { trigger: "context_recovery", originalPrompt: "Continue", recoveryCause: "maximum context length" });
    let row = db.prepare("SELECT status, target_session_id FROM context_checkpoints WHERE checkpoint_id = ?").get(checkpoint.checkpointId);
    expect(row).toEqual({ status: "prepared", target_session_id: null });
    commitContextCheckpoint(checkpoint, "provider-new");
    row = db.prepare("SELECT status, target_session_id FROM context_checkpoints WHERE checkpoint_id = ?").get(checkpoint.checkpointId);
    expect(row).toEqual({ status: "committed", target_session_id: "provider-new" });
    expect(checkpoint.recentEvents).toContain("assistant: Found the insertion point.");
  });

  it.each(["context_recovery", "proactive"] as const)(
    "marks %s swaps as fresh-provider continuations of the same run",
    (trigger) => {
      const checkpoint = compileContextCheckpoint(host(), {
        trigger,
        originalPrompt: "Continue",
        persist: false,
      });
      const options = checkpointStartOptions(checkpoint, {
        sessionKey: "stable-run",
        invocationKind: "resume_open_run",
        prompt: "Continue",
        cwd: "/repo",
        resumeId: "provider-old",
      });

      expect(options).toMatchObject({
        sessionKey: "stable-run",
        invocationKind: "provider_continuation",
        contextCheckpointId: checkpoint.checkpointId,
      });
      expect(options.resumeId).toBeUndefined();
    },
  );

  it("uses continuation semantics for proactive compaction", () => {
    const checkpoint = compileContextCheckpoint(host(), {
      trigger: "proactive",
      originalPrompt: "Continue",
      persist: false,
    });

    const prompt = renderCheckpointPrompt(checkpoint);
    expect(prompt).toContain("<session-continuation>");
    expect(prompt).toContain("</session-continuation>");
    expect(prompt).not.toContain("<previous-session-context>");
    expect(prompt).toContain(
      "reconstruct only entries proven missing",
    );
    expect(checkpoint.retainedState).toMatchObject({ taskRegistry: "available_at_capture", dashboard: "available_at_capture" });
  });

  it("uses context-window recovery semantics without claiming runtime loss", () => {
    const checkpoint = compileContextCheckpoint(host(), {
      trigger: "context_recovery",
      originalPrompt: "Continue",
      persist: false,
    });

    const prompt = renderCheckpointPrompt(checkpoint);
    expect(prompt).toContain("<context-window-recovery>");
    expect(prompt).toContain("</context-window-recovery>");
    expect(prompt).not.toContain("<previous-session-context>");
    expect(prompt).toContain("taskRegistry: available_at_capture");
  });

  it("detects contradictory progress before a swap", () => {
    const checkpoint = compileContextCheckpoint(host(), { trigger: "proactive", originalPrompt: "Continue", modelHandoff: "Goal: Continue" });
    checkpoint.progress.remaining.push(checkpoint.progress.completed[0]!);
    expect(validateCheckpoint(checkpoint)).toContain("A task appears in both completed and remaining state.");
  });
});
