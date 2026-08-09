/**
 * Prompt construction for the three Dialectic dialogue structures.
 *
 * Each planner keeps its OWN append-only thread. The orchestrator only ever
 * appends the peer's latest turn as a new user message, so these builders take
 * care to emit self-contained, incremental turn prompts (no restating of the
 * full history — that already lives in the session's cached context).
 */

import type { DialecticMode, DialecticSpeaker } from "../../shared/dialectic.ts";

const READONLY_PREAMBLE = [
  "You are a planning agent in a structured dialectic whose goal is to produce the strongest possible implementation plan.",
  "",
  "READ-ONLY: you may read files, search, and inspect the codebase to ground your reasoning, but you must NOT create, edit, or delete files, and must NOT run mutating commands. Produce reasoning and plans only.",
  "Keep each turn focused and substantive. Prefer concrete steps, risks, and decisions over restating what was already said.",
].join("\n");

interface RoleFraming {
  /** Persona/instructions for this speaker, appended to the read-only preamble. */
  system: string;
  /** Verb used when framing the peer's turn back to this speaker. */
  peerLabel: string;
  /** Per-turn instruction after the peer's message. */
  turnInstruction: string;
}

function framingFor(mode: DialecticMode, speaker: DialecticSpeaker): RoleFraming {
  if (mode === "proposer-critic") {
    return speaker === "A"
      ? {
          system:
            "Your role: PROPOSER. Draft and iteratively improve a concrete, actionable plan. Each round, incorporate the CRITIC's feedback and strengthen the plan; keep a clear current best version.",
          peerLabel: "The critic reviewed your latest plan",
          turnInstruction:
            "Revise your plan to address these critiques. Show the updated plan, and note what you changed and why.",
        }
      : {
          system:
            "Your role: CRITIC. Rigorously stress-test the proposer's latest plan: surface risks, edge cases, missing steps, hidden assumptions, and stronger alternatives. Be specific and constructive; do not rewrite the whole plan yourself.",
          peerLabel: "The proposer's latest plan",
          turnInstruction:
            "Critique this plan. Prioritise the most important gaps and risks, and suggest concrete improvements.",
        };
  }

  if (mode === "debate-synthesis") {
    return speaker === "A"
      ? {
          system:
            "Your role: ADVOCATE. Argue the case FOR the primary approach — defend and strengthen it, while honestly acknowledging real trade-offs.",
          peerLabel: "Your opponent argued",
          turnInstruction:
            "Respond to their argument: defend your position where it holds, concede where it doesn't, and sharpen the strongest version of your approach.",
        }
      : {
          system:
            "Your role: CHALLENGER. Argue for ALTERNATIVE approaches and against the weak points in the advocate's position, to stress-test the idea and expose failure modes.",
          peerLabel: "The advocate argued",
          turnInstruction:
            "Challenge their argument: expose weaknesses, propose alternatives, and make the strongest counter-case.",
        };
  }

  // ping-pong (symmetric peers)
  return {
    system:
      "Your role: PEER PLANNER. You and a symmetric peer alternate turns. Build on their strong ideas, challenge weak ones, and fill gaps to converge on the best plan.",
    peerLabel: "Your dialogue partner said",
    turnInstruction:
      "Advance the plan: extend what's strong, push back on what's weak, and add anything missing.",
  };
}

/** System prompt for a planner session (set once at session creation). */
export function buildPlannerSystemPrompt(mode: DialecticMode, speaker: DialecticSpeaker): string {
  const framing = framingFor(mode, speaker);
  return `${READONLY_PREAMBLE}\n\n${framing.system}`;
}

/** Planner A's first-turn prompt: introduces the topic. */
export function buildSeedPrompt(mode: DialecticMode, topic: string): string {
  const opener =
    mode === "proposer-critic"
      ? "Draft an initial plan for the following task."
      : mode === "debate-synthesis"
        ? "Open the debate by laying out your initial approach to the following task."
        : "Open the discussion with your initial thinking on the following task.";
  return `${opener}\n\n## Task\n${topic}`;
}

/**
 * Build the incremental turn prompt fed to a planner as a new user message.
 * `topic` is included only for a planner's very first turn (round 0 for B),
 * where the topic is not yet in its own thread history.
 */
export function buildTurnPrompt(input: {
  mode: DialecticMode;
  speaker: DialecticSpeaker;
  round: number;
  peerText: string;
  topic?: string;
}): string {
  const { mode, speaker, round, peerText, topic } = input;
  const framing = framingFor(mode, speaker);
  const parts: string[] = [];
  if (topic) {
    parts.push(`## Task\n${topic}\n`);
  }
  parts.push(`Round ${round + 1}. ${framing.peerLabel}:`);
  parts.push(`\n---\n${peerText.trim()}\n---\n`);
  parts.push(framing.turnInstruction);
  return parts.join("\n");
}

export const SYNTHESIS_SYSTEM_PROMPT = [
  "You are a neutral synthesizer. You did not participate in the debate.",
  "You are READ-ONLY: you may read and search the codebase to verify claims, but must not modify anything.",
  "Your job: read the full dialectic transcript and produce ONE final, well-structured plan that integrates the strongest ideas, resolves disagreements explicitly, and is directly actionable.",
].join("\n");

interface TranscriptEntry {
  speaker: DialecticSpeaker;
  round: number;
  text: string;
}

function speakerName(mode: DialecticMode, speaker: DialecticSpeaker): string {
  if (speaker === "synthesis") return "Synthesis";
  if (mode === "proposer-critic") return speaker === "A" ? "Proposer" : "Critic";
  if (mode === "debate-synthesis") return speaker === "A" ? "Advocate" : "Challenger";
  return speaker === "A" ? "Planner A" : "Planner B";
}

/** Assemble the synthesis prompt from the accumulated transcript. */
export function buildSynthesisPrompt(
  mode: DialecticMode,
  topic: string,
  transcript: ReadonlyArray<TranscriptEntry>,
): string {
  const body = transcript
    .map((e) => `### ${speakerName(mode, e.speaker)} — round ${e.round + 1}\n${e.text.trim()}`)
    .join("\n\n");
  return [
    `Below is a dialectic transcript between two planners about the following task.`,
    ``,
    `## Task`,
    topic,
    ``,
    `## Transcript`,
    body,
    ``,
    `## Your output`,
    `Produce the final plan in Markdown. Integrate the strongest points from both sides, explicitly resolve any disagreements, and make it directly actionable (concrete steps, sequencing, and risks).`,
  ].join("\n");
}
