import { describe, expect, it } from "vitest";
import { constraintVerdictSchema, reconciliationReportSchema } from "./reconcile.ts";

describe("reconciliationReportSchema", () => {
  it("defaults list fields", () => {
    const report = reconciliationReportSchema.parse({
      id: "recon_1",
      workPacketId: "wp_1",
      createdAt: 1,
      deterministic: {
        provenance: "deterministic",
        changedFiles: ["server/a.ts"],
        affectedCapabilities: [],
        affectedFlows: [],
        constraintsInScope: [],
        testsMissing: [],
        outOfScopeFiles: [],
        gateRequirements: [],
        diffSummary: "1 file changed",
      },
    });
    expect(report.provenance).toEqual({ deterministic: "deterministic" });
    expect(report.changedFiles).toEqual([]);
    expect(report.constraintVerdicts).toEqual([]);
  });

  it("labels reviewer verdicts separately from deterministic fields", () => {
    const verdict = constraintVerdictSchema.parse({
      constraintId: "constraint.bus_only",
      status: "appears_satisfied",
      evidence: ["reviewed diff"],
      provenance: "minion_judged",
      reviewedAt: 1,
    });

    expect(verdict.provenance).toBe("minion_judged");
  });
});
