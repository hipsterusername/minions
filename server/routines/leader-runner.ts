/**
 * Real `StepRunner` for the routine scheduler.
 *
 * Phase A's scheduler is pure orchestration over an injectable
 * `StepRunner`. This module fills that seam: it spawns a Leader session
 * per step, registers a `report_phase_result` MCP tool against that
 * session, and waits for either the tool call (happy path) or session
 * completion / abort (fallbacks) to resolve a `StepResult`.
 *
 * Decisions locked here
 * ─────────────────────
 *   - Routine-spawned leaders run **without** worktree isolation. Routines
 *     compose ideas, not code; they should not branch the repo per step.
 *   - Skills are armed at spawn time via the existing
 *     `compileSkills(loadSkillsByIds(...))` pipeline used by `assign_task`.
 *   - `mcpServerIds` on the step are resolved via `buildExternalMcpServers`
 *     and passed to the spawned leader through `StartSessionOptions`. Unknown
 *     IDs are silently dropped.
 *   - When a session ends without ever calling `report_phase_result`, the
 *     runner synthesises a result with outcome="error" and surfaces a
 *     descriptive message in `summary`/`error`. Fail-fast in the scheduler
 *     turns this into a routine-level error.
 */

import {
  registerStepContext,
  unregisterStepContext,
  type StepCompletionContext,
} from "./step-tools.ts";
import { LEADER_SYSTEM_PROMPT } from "../agents/leader.ts";
import { compileSkills, loadSkillsByIds } from "../skills.ts";
import { buildExternalMcpServers } from "./external-mcp.ts";
import type { StepRunArgs, StepRunner } from "./scheduler.ts";
import type { Bus } from "../bus.ts";
import type {
  Artifact,
  StepOutcome,
  StepResult,
} from "../../shared/routines/types.ts";

/**
 * Hooks the runner needs from the host server. Kept narrow so the runner
 * can be unit-tested without spinning up a real `SessionRegistry`.
 */
export interface LeaderRunnerDeps {
  /** The project root used to resolve skill IDs and MCP server IDs. */
  projectPath: string;
  /** Working directory for the spawned leader. */
  cwd: string;
  /** Channel for emitting bus events (session completion + step spawn). */
  bus: Bus;
  /**
   * Spawn a leader session. The implementation is the SessionRegistry's
   * `start()` in production; tests pass a fake.
   */
  startLeaderSession(opts: {
    sessionKey: string;
    prompt: string;
    cwd: string;
    systemPrompt: string;
    /** External MCP servers resolved from step.mcpServerIds. */
    externalMcpServers?: Record<string, unknown>;
    /** Formatted allowedTools entries for external servers. */
    externalMcpToolNames?: string[];
  }): void;
  /**
   * Best-effort: ask the registry to interrupt a running session. Used
   * when the runner has to give up on a step (timeout, abort).
   */
  abortSession?(sessionKey: string): void;
  /**
   * Subscribe to session-ended signals. The runner uses this as a
   * fallback to resolve a step that never called `report_phase_result`.
   * Returns an unsubscribe function. Production wiring listens to bus
   * `session_status` events with status="completed" | "error" | "stopped".
   */
  subscribeSessionEnded(
    sessionKey: string,
    handler: (info: { reason: string; isError: boolean }) => void,
  ): () => void;
  /** Override to make a sessionKey deterministic in tests. */
  generateSessionKey?(args: { runId: string; stepId: string }): string;
}

/** Returned by {@link createLeaderStepRunner} so callers can clean up. */
export interface LeaderStepRunnerHandle {
  /** Plug this into `runRoutine({ runner })`. */
  runner: StepRunner;
  /**
   * Map of stepId → spawned leader sessionKey. Populated as steps spawn,
   * cleared per-step when complete. Useful for the abort path so the
   * registry can tell which sessions to interrupt mid-run.
   */
  liveSessions: ReadonlyMap<string, string>;
}

/**
 * Build a `StepRunner` bound to the given deps. The returned runner can
 * execute one routine to completion; create a fresh runner per run so
 * `liveSessions` doesn't leak across runs.
 */
export function createLeaderStepRunner(
  deps: LeaderRunnerDeps,
): LeaderStepRunnerHandle {
  const liveSessions = new Map<string, string>();

  const runner: StepRunner = (args) => runOneStep(args, deps, liveSessions);

  return { runner, liveSessions };
}

/** Execute one step: spawn a leader, await its result. */
async function runOneStep(
  args: StepRunArgs,
  deps: LeaderRunnerDeps,
  liveSessions: Map<string, string>,
): Promise<StepResult> {
  const sessionKey =
    deps.generateSessionKey?.({ runId: args.runId, stepId: args.step.id }) ??
    `routine-${args.runId.slice(0, 8)}-${args.step.id}-${Date.now().toString(36)}`;

  liveSessions.set(args.step.id, sessionKey);

  const systemPrompt = composeSystemPrompt({
    base: args.step.systemPrompt ?? LEADER_SYSTEM_PROMPT,
    skillIds: args.step.skillIds,
    skillValues: args.step.skillValues,
    projectPath: deps.projectPath,
  });

  const userPrompt = composeUserPrompt(args);

  // Resolve external MCP servers from the step's mcpServerIds. Unknown ids
  // are silently dropped; empty ids produce empty results.
  const { mcpServers: externalMcpServers, toolNames: externalMcpToolNames } =
    buildExternalMcpServers(deps.projectPath, args.step.mcpServerIds);

  const result = await awaitStepResult({
    sessionKey,
    stepId: args.step.id,
    runId: args.runId,
    timeoutMs: args.step.timeoutMs,
    abortSession: deps.abortSession,
    onSpawn: () => {
      deps.startLeaderSession({
        sessionKey,
        prompt: userPrompt,
        cwd: deps.cwd,
        systemPrompt,
        ...(Object.keys(externalMcpServers).length > 0 && {
          externalMcpServers: externalMcpServers as Record<string, unknown>,
        }),
        ...(externalMcpToolNames.length > 0 && { externalMcpToolNames }),
      });
      deps.bus.emitGlobal({
        type: "routine_step_leader_spawned",
        runId: args.runId,
        phaseId: args.phase.id,
        stepId: args.step.id,
        sessionKey,
      });
    },
    subscribeSessionEnded: deps.subscribeSessionEnded,
  });

  liveSessions.delete(args.step.id);
  return { ...result, sessionKey };
}

/**
 * Build the leader's system prompt by appending compiled-skill text and a
 * routine-step addendum that explains the `report_phase_result` contract.
 */
function composeSystemPrompt(opts: {
  base: string;
  skillIds: readonly string[];
  skillValues: Record<string, Record<string, string>>;
  projectPath: string;
}): string {
  const skills = loadSkillsByIds(opts.projectPath, opts.skillIds);
  const skillsAddendum = compileSkills(skills, opts.skillValues);
  return opts.base + skillsAddendum + ROUTINE_STEP_ADDENDUM;
}

const ROUTINE_STEP_ADDENDUM = `

# Routine step

You are running as one step inside a Routine — a pre-defined orchestration
that runs your work, plus possibly other parallel steps, then reduces all
results into a handoff brief that the next phase's agents will see.

## Your contract

1. Do the work the routine prompt below asks for.
2. When you finish, **call \`report_phase_result\` exactly once** with:
   - \`outcome\`: "success", "error", or "aborted"
   - \`summary\`: one-paragraph what-you-did. The next phase reads this.
   - \`outputs\`: structured key/value findings (optional but encouraged).
   - \`artifacts\`: file paths or URLs you produced (optional).
3. Stop. The routine scheduler will start the next phase from your result.

Do **not** call \`request_approval\` — routine steps run without worktree
isolation and there is no diff to merge. Skip the approval workflow
entirely.
`;

/** Build the user prompt: warn about unresolved placeholders, then the step. */
function composeUserPrompt(args: StepRunArgs): string {
  const lines: string[] = [];
  if (args.unresolved.length > 0) {
    lines.push(
      `> _Note: the following template paths could not be resolved and ` +
        `were rendered empty: ${args.unresolved.join(", ")}._`,
      "",
    );
  }
  lines.push(args.renderedPrompt);
  return lines.join("\n");
}

interface AwaitStepResultArgs {
  sessionKey: string;
  stepId: string;
  runId: string;
  /** When set, a timeout fires after this many ms and resolves with outcome=error. */
  timeoutMs?: number;
  /** Called best-effort when the timeout fires to interrupt the running session. */
  abortSession?: (key: string) => void;
  onSpawn(): void;
  subscribeSessionEnded: LeaderRunnerDeps["subscribeSessionEnded"];
}

/**
 * Register a step-completion context, kick off the leader spawn, and
 * wait for either the `report_phase_result` call (happy path) or the
 * session ending without a result (synthesise an error).
 */
function awaitStepResult(
  args: AwaitStepResultArgs,
): Promise<StepResult> {
  return new Promise<StepResult>((resolveOuter) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const finalize = (result: StepResult): void => {
      if (settled) return;
      settled = true;
      unregisterStepContext(args.sessionKey);
      if (unsubscribe) unsubscribe();
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      resolveOuter(result);
    };

    const ctx: StepCompletionContext = {
      runId: args.runId,
      stepId: args.stepId,
      isSettled: () => settled,
      resolve: (payload) =>
        finalize(buildSuccessResult(args.stepId, payload)),
    };
    registerStepContext(args.sessionKey, ctx);

    unsubscribe = args.subscribeSessionEnded(args.sessionKey, (info) => {
      if (settled) return;
      finalize(buildFallbackResult(args.stepId, info));
    });

    if (args.timeoutMs !== undefined) {
      const ms = args.timeoutMs;
      timeoutHandle = setTimeout(() => {
        args.abortSession?.(args.sessionKey);
        const msg = `step timed out after ${ms}ms`;
        finalize({
          stepId: args.stepId,
          outcome: "error",
          summary: msg,
          outputs: {},
          artifacts: [],
          error: msg,
        });
      }, ms);
    }

    args.onSpawn();
  });
}

function buildSuccessResult(
  stepId: string,
  payload: {
    outcome: StepOutcome;
    summary: string;
    outputs?: Record<string, unknown>;
    artifacts?: Artifact[];
  },
): StepResult {
  const base: StepResult = {
    stepId,
    outcome: payload.outcome,
    summary: payload.summary,
    outputs: payload.outputs ?? {},
    artifacts: payload.artifacts ?? [],
  };
  return base;
}

function buildFallbackResult(
  stepId: string,
  info: { reason: string; isError: boolean },
): StepResult {
  const message =
    "Leader session ended without calling report_phase_result " +
    `(reason: ${info.reason}). The scheduler is treating this as an ` +
    "error so the routine can fail fast instead of hanging.";
  return {
    stepId,
    outcome: "error",
    summary: message,
    outputs: {},
    artifacts: [],
    error: message,
  };
}
