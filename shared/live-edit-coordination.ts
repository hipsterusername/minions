import { z } from "zod/v4";

const id = z.string().min(1);
const paths = z.array(z.string().min(1));
export const liveEditRunStateSchema = z.enum(["clean", "editing", "waiting"]);
const identity = { workItemId: id, runKey: id, runState: liveEditRunStateSchema,
  workItemState: liveEditRunStateSchema,
  workItemPaths: paths.optional(), workItemQueuePosition: z.number().int().positive().nullable().optional(),
  workItemBlockingRunKeys: z.array(id).optional(), workItemBaselineConflict: z.boolean().optional() };

export const liveEditCoordinationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queued"), ...identity, requestId: id, paths,
    queuePosition: z.number().int().positive(), blockingRunKeys: z.array(id), at: z.number().int().nonnegative() }),
  z.object({ type: z.literal("granted"), ...identity, requestId: id, token: id, paths,
    acquiredAt: z.number().int().nonnegative(), at: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
    maxHoldAt: z.number().int().nonnegative() }),
  z.object({ type: z.literal("heartbeat"), ...identity, token: id, paths,
    expiresAt: z.number().int().nonnegative(), at: z.number().int().nonnegative() }),
  z.object({ type: z.enum(["released", "expired"]), ...identity, token: id, paths,
    reason: z.string().optional(), at: z.number().int().nonnegative() }),
  z.object({ type: z.literal("cancelled"), ...identity, requestId: id, paths,
    at: z.number().int().nonnegative() }),
  z.object({ type: z.literal("baseline_conflict"), ...identity, token: id, paths,
    at: z.number().int().nonnegative() }),
]);

export const liveEditCoordinationEnvelopeSchema = z.object({
  topic: z.string().min(1), type: z.literal("live_edit_coordination"),
  workItemId: id, event: liveEditCoordinationEventSchema,
  timestamp: z.number().int().nonnegative(),
}).superRefine((value, ctx) => {
  if (value.workItemId !== value.event.workItemId
    || (value.topic.startsWith("work-item:") && value.topic !== `work-item:${value.workItemId}`)) {
    ctx.addIssue({ code: "custom", message: "coordination event identity mismatch" });
  }
  if (value.timestamp !== value.event.at) {
    ctx.addIssue({ code: "custom", message: "coordination timestamp mismatch" });
  }
});

export type LiveEditRunState = z.infer<typeof liveEditRunStateSchema>;
export type LiveEditCoordinationEvent = z.infer<typeof liveEditCoordinationEventSchema>;
export type LiveEditCoordinationEnvelope = z.infer<typeof liveEditCoordinationEnvelopeSchema>;

export const liveEditAwarenessSchema = z.object({ runState: liveEditRunStateSchema,
  paths, queuePosition: z.number().int().positive().nullable(),
  blockingRunKeys: z.array(id), baselineConflict: z.boolean(),
  updatedAt: z.number().int().nonnegative() });
export type LiveEditAwareness = z.infer<typeof liveEditAwarenessSchema>;

export function reduceLiveEditAwareness(
  current: LiveEditAwareness | undefined, event: LiveEditCoordinationEvent,
): LiveEditAwareness {
  if (current && event.at < current.updatedAt) return current;
  const eventPaths = event.workItemPaths ?? ("paths" in event ? event.paths : (current?.paths ?? []));
  return { runState: event.workItemState,
    paths: event.workItemState === "clean" ? [] : eventPaths,
    queuePosition: event.workItemQueuePosition !== undefined ? event.workItemQueuePosition
      : event.type === "queued" ? event.queuePosition
      : event.workItemState === "waiting" ? (current?.queuePosition ?? null) : null,
    blockingRunKeys: event.workItemBlockingRunKeys ?? (event.type === "queued" ? event.blockingRunKeys
      : event.workItemState === "waiting" ? (current?.blockingRunKeys ?? []) : []),
    baselineConflict: event.workItemBaselineConflict ?? (event.type === "baseline_conflict"
      ? true : event.workItemState !== "waiting" ? false : (current?.baselineConflict ?? false)),
    updatedAt: event.at,
  };
}

export function formatLiveEditAwareness(value: LiveEditAwareness | undefined): string | null {
  if (!value || value.runState === "clean") return null;
  const pathText = value.paths.length ? value.paths.join(", ") : "project files";
  const queue = value.queuePosition ? ` · queue #${value.queuePosition}` : "";
  const blockers = value.blockingRunKeys.length
    ? ` · blocked by ${value.blockingRunKeys.join(", ")}` : "";
  return `${pathText}${queue}${blockers}`;
}

export function formatCoordinatedLabel(label: string,
  awareness: LiveEditAwareness | undefined): string {
  const detail = formatLiveEditAwareness(awareness);
  return detail ? `${label} · ${detail}` : label;
}
