/**
 * Dialectic orchestrator — deterministic, server-driven turn-taking across two
 * planner sessions plus a final synthesis pass.
 *
 * This is NOT an LLM loop. It is plain server code that:
 *   1. launches two planner sessions with DISTINCT keys (even for identical
 *      model/harness) via the injected `startSession`,
 *   2. awaits each turn's final text through the turn bridge,
 *   3. resumes the peer's session with only the latest turn as a new user
 *      message — keeping each planner's cached prefix stable,
 *   4. after N rounds, runs a synthesis session that emits the final plan.
 *
 * All fan-out goes through the injected `emit` (wired to the typed bus by the
 * command handler); the orchestrator never touches the bus or SessionHost
 * internals directly, which keeps it small and unit-testable.
 */

import type { StartSessionOptions } from "../session-host-types.ts";
import {
  type DialecticConfig,
  type DialecticEvent,
  type DialecticSpeaker,
  dialecticSessionKeys,
  resolveSynthesisPlanner,
} from "../../shared/dialectic.ts";
import {
  buildPlannerSystemPrompt,
  buildSeedPrompt,
  buildSynthesisPrompt,
  buildTurnPrompt,
  SYNTHESIS_SYSTEM_PROMPT,
} from "./modes.ts";
import type { DialecticTurnResult } from "./turn-bridge.ts";

export interface DialecticOrchestratorDeps {
  startSession: (opts: StartSessionOptions) => void;
  getRuntime: (sessionKey: string) => { sessionId: string | null } | null;
  terminate: (sessionKey: string) => void;
  emit: (event: DialecticEvent) => void;
  awaitTurn: (sessionKey: string) => Promise<DialecticTurnResult>;
  cancelTurn: (sessionKey: string) => void;
}

interface TranscriptEntry {
  speaker: DialecticSpeaker;
  round: number;
  text: string;
}

/** Compose a run-status error message, appending the planner's real error when present. */
function turnFailure(label: string, error?: string): string {
  const detail = error?.trim();
  return detail ? `${label} turn failed: ${detail}` : `${label} turn failed`;
}

export class DialecticOrchestrator {
  private aborted = false;
  private running = false;
  private readonly keys: ReturnType<typeof dialecticSessionKeys>;

  constructor(
    private readonly nodeId: string,
    private readonly cwd: string,
    private readonly config: DialecticConfig,
    private readonly deps: DialecticOrchestratorDeps,
  ) {
    this.keys = dialecticSessionKeys(nodeId);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Drive the full dialogue for `topic`. Resolves when done, stopped, or errored. */
  async run(topic: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.aborted = false;
    const transcript: TranscriptEntry[] = [];

    try {
      this.deps.emit({ kind: "run_status", status: "running" });
      let lastA = "";
      let lastB = "";

      for (let round = 0; round < this.config.rounds; round++) {
        if (this.aborted) break;

        const aPrompt =
          round === 0
            ? buildSeedPrompt(this.config.mode, topic)
            : buildTurnPrompt({ mode: this.config.mode, speaker: "A", round, peerText: lastB });
        this.deps.emit({
          kind: "turn_started",
          speaker: "A",
          round,
          context: {
            prompt: aPrompt,
            ...(round === 0
              ? { systemPrompt: buildPlannerSystemPrompt(this.config.mode, "A") }
              : {}),
            retainedThread: round > 0,
          },
        });
        this.launchPlanner("A", round, aPrompt);
        const a = await this.deps.awaitTurn(this.keys.plannerA);
        if (this.aborted) break;
        lastA = a.text;
        transcript.push({ speaker: "A", round, text: a.text });
        this.deps.emit({ kind: "turn_completed", speaker: "A", round, text: a.text, isError: a.isError });
        if (a.isError) throw new Error(turnFailure("Planner A", a.error));

        const bPrompt = buildTurnPrompt({
          mode: this.config.mode,
          speaker: "B",
          round,
          peerText: lastA,
          // B needs the topic on its very first turn (not yet in its thread).
          topic: round === 0 ? topic : undefined,
        });
        this.deps.emit({
          kind: "turn_started",
          speaker: "B",
          round,
          context: {
            prompt: bPrompt,
            ...(round === 0
              ? { systemPrompt: buildPlannerSystemPrompt(this.config.mode, "B") }
              : {}),
            retainedThread: round > 0,
          },
        });
        this.launchPlanner("B", round, bPrompt);
        const b = await this.deps.awaitTurn(this.keys.plannerB);
        if (this.aborted) break;
        lastB = b.text;
        transcript.push({ speaker: "B", round, text: b.text });
        this.deps.emit({ kind: "turn_completed", speaker: "B", round, text: b.text, isError: b.isError });
        if (b.isError) throw new Error(turnFailure("Planner B", b.error));
      }

      if (this.aborted) {
        this.deps.emit({ kind: "run_status", status: "stopped" });
        return;
      }

      const synthRound = this.config.rounds;
      const synth = resolveSynthesisPlanner(this.config);
      const synthesisPrompt = buildSynthesisPrompt(this.config.mode, topic, transcript);
      this.deps.emit({
        kind: "turn_started",
        speaker: "synthesis",
        round: synthRound,
        context: {
          prompt: synthesisPrompt,
          systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
          retainedThread: false,
        },
      });
      this.deps.startSession({
        sessionKey: this.keys.synthesis,
        invocationKind: "new_run",
        prompt: synthesisPrompt,
        cwd: this.cwd,
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
        role: "dialectic-planner",
        initialModel: synth.model,
        harness: synth.harness,
        permissionMode: "plan",
      });
      const s = await this.deps.awaitTurn(this.keys.synthesis);
      if (this.aborted) {
        this.deps.emit({ kind: "run_status", status: "stopped" });
        return;
      }
      this.deps.emit({
        kind: "turn_completed",
        speaker: "synthesis",
        round: synthRound,
        text: s.text,
        isError: s.isError,
      });
      if (s.isError) throw new Error(turnFailure("Synthesis", s.error));
      this.deps.emit({ kind: "synthesis", document: s.text });
      this.deps.emit({ kind: "run_status", status: "completed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.emit({ kind: "run_status", status: "error", error: message });
    } finally {
      this.running = false;
    }
  }

  /** Abort an in-flight run and tear down the planner sessions. */
  stop(): void {
    this.aborted = true;
    for (const key of [this.keys.plannerA, this.keys.plannerB, this.keys.synthesis]) {
      this.deps.cancelTurn(key);
      this.deps.terminate(key);
    }
    if (!this.running) {
      this.deps.emit({ kind: "run_status", status: "stopped" });
    }
  }

  private launchPlanner(speaker: "A" | "B", round: number, prompt: string): void {
    const key = speaker === "A" ? this.keys.plannerA : this.keys.plannerB;
    const planner = speaker === "A" ? this.config.plannerA : this.config.plannerB;

    if (round === 0) {
      // First turn: brand-new session with the mode/speaker system prompt.
      this.deps.startSession({
        sessionKey: key,
        invocationKind: "new_run",
        prompt,
        cwd: this.cwd,
        systemPrompt: buildPlannerSystemPrompt(this.config.mode, speaker),
        role: "dialectic-planner",
        initialModel: planner.model,
        harness: planner.harness,
        permissionMode: "plan",
      });
      return;
    }

    // Later turns: resume the SAME thread so its cached prefix is preserved;
    // only the peer's latest turn (prompt) is appended as a new user message.
    const runtime = this.deps.getRuntime(key);
    this.deps.startSession({
      sessionKey: key,
      invocationKind: "resume_open_run",
      prompt,
      cwd: this.cwd,
      resumeId: runtime?.sessionId ?? undefined,
      harness: planner.harness,
    });
  }
}
