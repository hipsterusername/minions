import type {
  CriterionCoverage,
  WorkPacket,
  WorkPacketEvidence,
  WorkPacketSignal,
} from "../../shared/system-model/index.ts";

export interface EvidenceAppendInput extends Omit<WorkPacketEvidence, "id" | "createdAt"> {
  id?: string;
}

export interface CriterionCoverageUpdate {
  criterionId: string;
  status: CriterionCoverage["status"];
  objectIds?: string[];
  evidenceRefs?: string[];
  notes?: string;
  provenance: CriterionCoverage["provenance"];
}

export interface SignalUpdate extends Omit<WorkPacketSignal, "id" | "createdAt" | "updatedAt"> {
  id?: string;
}

export function initializeWorkPacketState(
  acceptanceCriteria: string[] | undefined,
  now: number,
): Pick<WorkPacket, "criterionCoverage" | "evidenceLedger" | "signals"> {
  const criteria = unique((acceptanceCriteria ?? []).map((criterion) => criterion.trim()).filter(Boolean));
  const criterionCoverage: CriterionCoverage[] = criteria.map((criterion, index) => ({
    criterionId: `criterion-${index + 1}`,
    criterion,
    status: "open",
    objectIds: [],
    evidenceRefs: [],
    provenance: "human",
    updatedAt: now,
  }));
  return {
    criterionCoverage,
    evidenceLedger: [],
    signals: criterionCoverage.map((coverage) => ({
      id: coverageGapSignalId(coverage.criterionId),
      type: "coverage_gap",
      priority: "high",
      status: "open",
      summary: `Acceptance criterion lacks supporting evidence: ${coverage.criterion}`,
      criterionIds: [coverage.criterionId],
      objectIds: [],
      evidenceRefs: [],
      createdAt: now,
      updatedAt: now,
    })),
  };
}

export function applyWorkPacketStateUpdates(input: {
  packet: WorkPacket;
  evidence: EvidenceAppendInput[];
  coverageUpdates: CriterionCoverageUpdate[];
  signalUpdates: SignalUpdate[];
  now: number;
}): WorkPacket {
  const evidenceLedger = [...(input.packet.evidenceLedger ?? [])];
  const criterionCoverage = [...(input.packet.criterionCoverage ?? [])];
  const signals = [...(input.packet.signals ?? [])];
  const knownCriteria = new Set(criterionCoverage.map((item) => item.criterionId));

  input.evidence.forEach((item, index) => {
    assertKnownCriteria(item.criterionIds, knownCriteria);
    const id = item.id ?? `evidence-${input.now}-${index + 1}`;
    if (evidenceLedger.some((existing) => existing.id === id)) {
      throw new Error(`Evidence id ${id} already exists; the evidence ledger is append-only`);
    }
    evidenceLedger.push({ ...item, id, createdAt: input.now });
  });

  for (const update of input.coverageUpdates) {
    const index = criterionCoverage.findIndex((item) => item.criterionId === update.criterionId);
    if (index < 0) throw new Error(`Unknown acceptance criterion ${update.criterionId}`);
    const current = criterionCoverage[index]!;
    const evidenceRefs = unique([...(current.evidenceRefs ?? []), ...(update.evidenceRefs ?? [])]);
    const ledgerSupportsCriterion = evidenceLedger.some((item) =>
      item.criterionIds.includes(update.criterionId));
    if ((update.status === "supported" || update.status === "verified")
      && evidenceRefs.length === 0 && !ledgerSupportsCriterion) {
      throw new Error(`${update.status} coverage for ${update.criterionId} requires evidence`);
    }
    criterionCoverage[index] = {
      ...current,
      status: update.status,
      objectIds: unique([...(current.objectIds ?? []), ...(update.objectIds ?? [])]),
      evidenceRefs,
      notes: update.notes ?? current.notes,
      provenance: update.provenance,
      updatedAt: input.now,
    };
    const signalIndex = signals.findIndex((item) => item.id === coverageGapSignalId(update.criterionId));
    if (signalIndex >= 0 && isCovered(update.status)) {
      signals[signalIndex] = {
        ...signals[signalIndex]!,
        status: update.status === "waived" ? "waived" : "addressed",
        evidenceRefs,
        resolution: update.notes ?? `Coverage marked ${update.status}`,
        updatedAt: input.now,
      };
    }
  }

  input.signalUpdates.forEach((update, index) => {
    assertKnownCriteria(update.criterionIds, knownCriteria);
    const id = update.id ?? `signal-${input.now}-${index + 1}`;
    const existingIndex = signals.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      const current = signals[existingIndex]!;
      signals[existingIndex] = {
        ...current,
        ...update,
        id,
        criterionIds: unique([...current.criterionIds, ...update.criterionIds]),
        objectIds: unique([...current.objectIds, ...update.objectIds]),
        evidenceRefs: unique([...current.evidenceRefs, ...update.evidenceRefs]),
        createdAt: current.createdAt,
        updatedAt: input.now,
      };
    } else {
      signals.push({ ...update, id, createdAt: input.now, updatedAt: input.now });
    }
  });

  return { ...input.packet, criterionCoverage, evidenceLedger, signals };
}

function coverageGapSignalId(criterionId: string): string {
  return `signal.coverage_gap.${criterionId}`;
}

function isCovered(status: CriterionCoverage["status"]): boolean {
  return status === "supported" || status === "verified" || status === "waived";
}

function assertKnownCriteria(criterionIds: string[], known: Set<string>): void {
  const unknown = criterionIds.find((id) => !known.has(id));
  if (unknown) throw new Error(`Unknown acceptance criterion ${unknown}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
