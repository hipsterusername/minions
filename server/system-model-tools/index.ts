import type { NormalizedToolDef } from "../harness/types.ts";
import {
  createQuerySystemModelToolDef,
  type SystemModelToolContext,
} from "./query-system-model.ts";

export function createSystemModelToolsForLeader(ctx: SystemModelToolContext): NormalizedToolDef[] {
  return [createQuerySystemModelToolDef(ctx)];
}

export type { SystemModelToolContext };
