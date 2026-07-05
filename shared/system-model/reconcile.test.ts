import { describe, expect, it } from "vitest";
import { reconciliationReportSchema } from "./reconcile.ts";

describe("reconciliationReportSchema", () => {
  it("defaults list fields", () => {
    const report = reconciliationReportSchema.parse({
      id: "recon_1",
      workPacketId: "wp_1",
      createdAt: 1,
    });
    expect(report.provenance).toBe("deterministic");
    expect(report.changedFiles).toEqual([]);
  });
});
