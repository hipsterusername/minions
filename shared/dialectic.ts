/**
 * Dialectic dual-planner contract — shared by client (`src/`) and server
 * (`server/`).
 *
 * A Dialectic node runs TWO planner sessions in a structured, deterministic
 * back-and-forth. The two planners are always distinct sessions (distinct
 * session keys) even when the same model/harness/family is chosen for both.
 *
 * This module is the single source of truth for:
 *   - the configurable dialogue *modes* (structures),
 *   - the run configuration a client sends to start a dialectic,
 *   - the coordinator event shapes the server fans back to the node.
 *
 * It holds no runtime state and imports nothing server- or React-specific,
 * so both trees can depend on it without crossing the tree boundary.
 */

// ── Dialogue structures (configurable) ──────────────────────────────────────

/**
 * The three dialogue structures. All three end with a synthesis pass that
 * produces the final plan document; they differ in how the two planners take
 * turns during the dialogue.
 */
export type DialecticMode =
  | "ping-pong"
  | "proposer-critic"
  | "debate-synthesis";

export interface DialecticModeInfo {
  id: DialecticMode;
  label: string;
  /** One-line explanation shown in the node's mode picker. */
  description: string;
}

/** Ordered list for UI pickers. Keep in sync with {@link DialecticMode}. */
export const DIALECTIC_MODES: ReadonlyArray<DialecticModeInfo> = [
  {
    id: "ping-pong",
    label: "Ping-pong peers",
    description:
      "Two symmetric planners alternate; each turn sees the other's latest reply and builds on or challenges it.",
  },
  {
    id: "proposer-critic",
    label: "Proposer / Critic",
    description:
      "Planner A drafts and refines a plan; Planner B critiques it each round. Roles are fixed.",
  },
  {
    id: "debate-synthesis",
    label: "Debate → Synthesis",
    description:
      "Planners argue distinct positions to stress-test the idea, then a synthesis pass reconciles them.",
  },
];

const MODE_IDS: ReadonlySet<string> = new Set(DIALECTIC_MODES.map((m) => m.id));

export function isDialecticMode(v: unknown): v is DialecticMode {
  return typeof v === "string" && MODE_IDS.has(v);
}

// ── Round bounds ────────────────────────────────────────────────────────────

/** A round = one Planner A turn followed by one Planner B turn. */
export const DEFAULT_DIALECTIC_ROUNDS = 3;
export const MIN_DIALECTIC_ROUNDS = 1;
export const MAX_DIALECTIC_ROUNDS = 8;

/** Clamp an arbitrary number to the supported round range (integer). */
export function normalizeRounds(n: unknown): number {
  const raw = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : DEFAULT_DIALECTIC_ROUNDS;
  if (raw < MIN_DIALECTIC_ROUNDS) return MIN_DIALECTIC_ROUNDS;
  if (raw > MAX_DIALECTIC_ROUNDS) return MAX_DIALECTIC_ROUNDS;
  return raw;
}

// ── Run configuration ───────────────────────────────────────────────────────

/** One planner's model/harness selection. */
export interface PlannerConfig {
  /** Registered AgentHarness name (e.g. "claude"). */
  harness: string;
  /** Concrete model id/alias understood by the harness. */
  model: string;
}

export interface DialecticConfig {
  mode: DialecticMode;
  /** Number of A↔B exchanges before synthesis. */
  rounds: number;
  plannerA: PlannerConfig;
  plannerB: PlannerConfig;
  /**
   * Harness/model that writes the final synthesized plan. Defaults to
   * planner A's selection when omitted.
   */
  synthesis?: PlannerConfig;
}

export function createDefaultPlannerConfig(): PlannerConfig {
  return { harness: "claude", model: "claude-sonnet-5" };
}

export function createDefaultDialecticConfig(): DialecticConfig {
  return {
    mode: "ping-pong",
    rounds: DEFAULT_DIALECTIC_ROUNDS,
    plannerA: createDefaultPlannerConfig(),
    plannerB: createDefaultPlannerConfig(),
  };
}

/**
 * Coerce loosely-typed input (persisted node data, a WS command) into a valid
 * config, filling defaults and clamping rounds. Never throws.
 */
export function normalizeDialecticConfig(input: unknown): DialecticConfig {
  const base = createDefaultDialecticConfig();
  if (!input || typeof input !== "object") return base;
  const o = input as Record<string, unknown>;
  const rawMode = o["mode"];
  const mode = isDialecticMode(rawMode) ? rawMode : base.mode;
  const rounds = normalizeRounds(o["rounds"]);
  const plannerA = normalizePlanner(o["plannerA"]) ?? base.plannerA;
  const plannerB = normalizePlanner(o["plannerB"]) ?? base.plannerB;
  const synthesis = normalizePlanner(o["synthesis"]);
  return synthesis
    ? { mode, rounds, plannerA, plannerB, synthesis }
    : { mode, rounds, plannerA, plannerB };
}

function normalizePlanner(v: unknown): PlannerConfig | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const rawHarness = o["harness"];
  const harness = typeof rawHarness === "string" && rawHarness.trim() ? rawHarness : "claude";
  const rawModel = o["model"];
  const model = typeof rawModel === "string" && rawModel.trim() ? rawModel : undefined;
  if (!model) return undefined;
  return { harness, model };
}

/** Resolve the effective synthesis planner (falls back to planner A). */
export function resolveSynthesisPlanner(config: DialecticConfig): PlannerConfig {
  return config.synthesis ?? config.plannerA;
}

// ── Turn / speaker model ─────────────────────────────────────────────────────

export type DialecticSpeaker = "A" | "B" | "synthesis";

export type DialecticRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "stopped"
  | "error";

/**
 * Coordinator events fanned to the node's topic (distinct from the two
 * planners' own session streams, which the node also subscribes to for live
 * transcripts). These carry orchestration progress and the final document.
 */
export type DialecticEvent =
  | { kind: "run_status"; status: DialecticRunStatus; error?: string }
  | { kind: "turn_started"; speaker: DialecticSpeaker; round: number }
  | {
      kind: "turn_completed";
      speaker: DialecticSpeaker;
      round: number;
      text: string;
      isError?: boolean;
    }
  | { kind: "synthesis"; document: string };

/** WS envelope `type` used for coordinator events on the node topic. */
export const DIALECTIC_EVENT_TYPE = "dialectic_update";

/** Derive the coordinator + planner session keys from a node id. */
export function dialecticSessionKeys(nodeId: string): {
  coordinator: string;
  plannerA: string;
  plannerB: string;
  synthesis: string;
} {
  const base = `dialectic-${nodeId}`;
  return {
    coordinator: base,
    plannerA: `${base}-A`,
    plannerB: `${base}-B`,
    synthesis: `${base}-S`,
  };
}
