/**
 * WebSocket envelope — the typed wrapper every server → client message
 * flows through.
 *
 * The envelope adds a `topic` field that clients can subscribe to. Legacy
 * listeners that switch on `type` alone keep working because `type` and
 * all payload fields are preserved at the top level — this is an additive
 * wrapper, not a nested one.
 *
 * ```jsonc
 * // Before (firehose):
 * { "type": "task_plan_update", "leaderSessionKey": "leader-abc", "tasks": [...] }
 *
 * // After (envelope; `topic` added, rest unchanged):
 * { "topic": "session:leader-abc", "type": "task_plan_update",
 *   "leaderSessionKey": "leader-abc", "tasks": [...] }
 * ```
 *
 * Topic grammar:
 *   - `session:<sessionKey>` — events scoped to a single session
 *   - `project:<projectId>`  — events scoped to a project (multi-session)
 *   - `global`               — events every client should see
 *
 * Adding a new topic shape means editing this file (and the client
 * subscribe matcher). Keep the grammar small on purpose.
 */

import { z } from "zod/v4";

// ── Topic ──────────────────────────────────────────────

export const sessionTopicSchema = z
  .string()
  .regex(/^session:.+$/, "session topics are `session:<sessionKey>`");

export const projectTopicSchema = z
  .string()
  .regex(/^project:.+$/, "project topics are `project:<projectId>`");

export const globalTopicSchema = z.literal("global");

/**
 * Union of valid topics. We use a plain string union validated by regex
 * rather than template-literal types so the matchers are easy to swap
 * out for a different scheme later.
 */
export const topicSchema = z.union([
  sessionTopicSchema,
  projectTopicSchema,
  globalTopicSchema,
]);

export type Topic = z.infer<typeof topicSchema>;

// ── Envelope ───────────────────────────────────────────

/**
 * The envelope is intentionally additive: it asserts the presence of a
 * `topic` field and a `type` discriminator, but passes the rest of the
 * payload through unchanged.
 *
 * Every existing server broadcast must parse against this schema once the
 * bus wraps it; the contract test in `tests/contracts/ws-envelope.test.ts`
 * locks that in.
 */
export const wsEnvelopeSchema = z.looseObject({
  topic: topicSchema,
  type: z.string(),
});

export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;

export const sessionCompactedEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("session_compacted"),
  sessionKey: z.string(),
  oldSessionId: z.string().nullable(),
  newSessionId: z.string().nullable(),
  contextTokensBefore: z.number().optional(),
  contextWindowTokens: z.number().optional(),
  ratioBefore: z.number().optional(),
  timestamp: z.number(),
});

// ── Helpers ────────────────────────────────────────────

/** Build a session-scoped topic. */
export function sessionTopic(sessionKey: string): Topic {
  if (!sessionKey) throw new Error("sessionTopic: sessionKey is required");
  return `session:${sessionKey}`;
}

/** Build a project-scoped topic. */
export function projectTopic(projectId: string): Topic {
  if (!projectId) throw new Error("projectTopic: projectId is required");
  return `project:${projectId}`;
}

/** The global topic constant. */
export const GLOBAL_TOPIC: Topic = "global";

/**
 * Extract the key from a `session:<key>` topic. Returns null for other
 * topic kinds.
 */
export function sessionKeyFromTopic(topic: string): string | null {
  if (!topic.startsWith("session:")) return null;
  return topic.slice("session:".length);
}

/**
 * Decide whether an envelope matches a subscription topic filter.
 *
 * Matching rules:
 *   - `"global"` subscription receives only global-topic envelopes.
 *   - `"session:<key>"` or `"project:<id>"` subscription receives only
 *     that exact topic.
 *   - The sentinel `"*"` filter receives *every* envelope. Used by
 *     backward-compat firehose consumers during migration.
 */
export function topicMatches(filter: string, envelopeTopic: string): boolean {
  if (filter === "*") return true;
  return filter === envelopeTopic;
}
