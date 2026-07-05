import type { NormalizedToolDef } from "../harness/types.ts";
import { createAmendWorkPacketToolDef } from "./amend-work-packet.ts";
import { createCheckFreshnessToolDef } from "./check-freshness.ts";
import { createCreateWorkPacketToolDef } from "./create-work-packet.ts";
import { createQuerySystemModelToolDef } from "./query-system-model.ts";
import { createRecordVerificationToolDef } from "./record-verification.ts";
import type { SystemModelToolContext } from "./shared.ts";

export function createSystemModelToolsForLeader(ctx: SystemModelToolContext): NormalizedToolDef[] {
  return [
    createQuerySystemModelToolDef(ctx),
    createCreateWorkPacketToolDef(ctx),
    createAmendWorkPacketToolDef(ctx),
    createCheckFreshnessToolDef(ctx),
    createRecordVerificationToolDef(ctx),
  ];
}

export type { SystemModelToolContext };
