/**
 * Deterministic packet-applicability logic — the single source of truth for
 * "does this set of files touch a gated surface?" (system-model redesign §5).
 *
 * Pure and dependency-light: consumed by `compile.ts` (packet scoping), the
 * `plan_task` / `assign_task` structural trigger, and the leader prompt
 * addendum (`gatedSurfaceGlobs`). No I/O, no logging — just glob math.
 */

import type { LoadedSystemModel } from "./types.ts";
import { globMatches } from "./match.ts";

export interface PacketApplicability {
  /** True when any file hit a review-gate glob or a critical-constraint glob. */
  packetRequired: boolean;
  /** Ids of review gates whose file globs matched. */
  gateHits: string[];
  /** Ids of critical constraints whose file globs matched. */
  constraintHits: string[];
}

const EMPTY: PacketApplicability = { packetRequired: false, gateHits: [], constraintHits: [] };

/**
 * Compute whether `files` intersect any review-gate glob or any *critical*
 * constraint glob. Files-only by design: this is the deterministic predicate
 * that replaces the prose "packet required" rule in the leader prompt. An
 * empty file list can never require a packet (silence is the default).
 */
export function computePacketApplicability(
  model: LoadedSystemModel,
  files: string[],
): PacketApplicability {
  if (files.length === 0) return EMPTY;
  const gateHits = model.policies.reviewGates
    .filter((gate) => files.some((file) => gate.requiredWhen.files.some((glob) => globMatches(glob, file))))
    .map((gate) => gate.id);
  const constraintHits = model.constraints
    .filter((constraint) =>
      constraint.severity === "critical"
      && files.some((file) => constraint.appliesTo.files.some((glob) => globMatches(glob, file))))
    .map((constraint) => constraint.id);
  return {
    packetRequired: gateHits.length > 0 || constraintHits.length > 0,
    gateHits,
    constraintHits,
  };
}

/**
 * Unique, sorted list of gated-surface globs (review gates + critical
 * constraints) for the leader prompt addendum (§6). After §4 rescoping this
 * list is small; the caller still enforces the addendum token budget.
 */
export function gatedSurfaceGlobs(model: LoadedSystemModel): string[] {
  const globs = [
    ...model.policies.reviewGates.flatMap((gate) => gate.requiredWhen.files),
    ...model.constraints
      .filter((constraint) => constraint.severity === "critical")
      .flatMap((constraint) => constraint.appliesTo.files),
  ];
  return [...new Set(globs)].sort();
}

/**
 * Render the compact packet note appended to a plan_task / assign_task result
 * on a gate hit. Empty string on a miss — no extra bytes when nothing fires.
 * `remindWorkPacket` adds the assign-side one-liner when no packet was passed.
 */
export function renderPacketNote(
  applicability: PacketApplicability,
  opts?: { remindWorkPacket?: boolean },
): string {
  if (!applicability.packetRequired) return "";
  const hits = [...applicability.gateHits, ...applicability.constraintHits].join(", ");
  const base = `\n\nsystemModel: { packetRequired: true, gateHits: [${hits}] }`;
  return opts?.remindWorkPacket
    ? `${base}\nPass a workPacketId (create_work_packet) so the minion receives the Context Pack.`
    : base;
}
