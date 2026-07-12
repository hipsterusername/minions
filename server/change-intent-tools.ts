import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { NormalizedToolDef } from "./harness/types.ts";
import type { RunMutationCoordination } from "./mutation-coordination.ts";

const openSchema = z.object({
  paths: z.array(z.object({ path: z.string().min(1),
    scope: z.enum(["file", "prefix"]).default("file") })).default([]),
  repositoryWide: z.boolean().default(false),
}).refine((value) => value.repositoryWide || value.paths.length > 0,
  "paths are required unless repositoryWide is true");
const closeSchema = z.object({ token: z.string().min(1) });
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function createChangeIntentTools(coordination: RunMutationCoordination | undefined): NormalizedToolDef[] {
  const requireCoordination = () => {
    if (!coordination) throw new Error(
      "change intents require a canonical live-mode work item; use worktree mode for this run");
    return coordination;
  };
  return [{
    name: "open_change_intent",
    description: "Acquire a temporary live-edit intent for files you are directly considering or changing.",
    inputSchema: openSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (raw) => {
      const input = openSchema.parse(raw); const bridge = requireCoordination();
      const lease = await bridge.openIntent(`intent:${bridge.runKey}:${randomUUID()}`,
        input.paths, input.repositoryWide);
      return text({ token: lease.token, paths: lease.paths.map((path) => path.path),
        expiresAt: lease.expiresAt, maxHoldAt: lease.maxHoldAt });
    },
  }, {
    name: "close_change_intent",
    description: "Release a previously opened live-edit intent as soon as direct file consideration ends.",
    inputSchema: closeSchema,
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (raw) => {
      const input = closeSchema.parse(raw); requireCoordination().closeIntent(input.token);
      return text({ closed: true, token: input.token });
    },
  }];
}
