import type { NormalizedToolDef } from "../harness/types.ts";
import { createAmendWorkPacketToolDef } from "./amend-work-packet.ts";
import { createCheckFreshnessToolDef } from "./check-freshness.ts";
import { createCreateWorkPacketToolDef } from "./create-work-packet.ts";
import { createModelHealthToolDef } from "./model-health.ts";
import { createQuerySystemModelToolDef } from "./query-system-model.ts";
import { createReconcileRunToolDef } from "./reconcile-run.ts";
import { createRecordConstraintVerdictsToolDef } from "./record-constraint-verdicts.ts";
import { createRecordVerificationToolDef } from "./record-verification.ts";
import { createRecordWorkPacketEvidenceToolDef } from "./record-work-packet-evidence.ts";
import type { SystemModelToolContext } from "./shared.ts";

export function createSystemModelToolsForLeader(ctx: SystemModelToolContext): NormalizedToolDef[] {
  return [
    createQuerySystemModelToolDef(ctx),
    createCreateWorkPacketToolDef(ctx),
    createAmendWorkPacketToolDef(ctx),
    createCheckFreshnessToolDef(ctx),
    createRecordVerificationToolDef(ctx),
    createRecordWorkPacketEvidenceToolDef(ctx),
    createReconcileRunToolDef(ctx),
    createRecordConstraintVerdictsToolDef(ctx),
    createModelHealthToolDef(ctx),
  ];
}

export type { SystemModelToolContext };
