import { describe, expect, it } from "vitest";
import { checkFreshness, clearFreshnessCache, type FreshnessTimestampFn } from "./freshness.ts";

const policies = [
  { policyClass: "ordinary", consequence: "verify_before_task" as const, requiredActions: ["inspect code"] },
  { policyClass: "permission_sensitive", consequence: "block_if_unverified" as const, requiredActions: ["check permissions"] },
  { policyClass: "billing_sensitive", consequence: "required_agent_actions" as const, requiredActions: ["check billing"] },
];

describe("checkFreshness", () => {
  it("classifies fresh, stale, stale-blocked, and unknown subjects", async () => {
    clearFreshnessCache();
    const timestamps: FreshnessTimestampFn = async ({ objectFile }) => ({
      "fresh.yaml": { modelTouchedAt: 20, codeTouchedAt: 10 },
      "stale.yaml": { modelTouchedAt: 10, codeTouchedAt: 20 },
      "blocked.yaml": { modelTouchedAt: 10, codeTouchedAt: 30 },
      "unknown.yaml": { modelTouchedAt: null, codeTouchedAt: 30 },
    })[objectFile]!;

    const report = await checkFreshness({
      cwd: "/repo",
      headSha: "abc",
      mode: "enforced",
      policies,
      getTimestamps: timestamps,
      subjects: [
        subject("fresh", "fresh.yaml"),
        subject("stale", "stale.yaml"),
        subject("blocked", "blocked.yaml", "permission_sensitive"),
        subject("unknown", "unknown.yaml"),
      ],
    });

    expect(report.status).toBe("unknown");
    expect(report.objects.map((object) => [object.objectId, object.status])).toEqual([
      ["fresh", "fresh"],
      ["stale", "stale"],
      ["blocked", "stale"],
      ["unknown", "unknown"],
    ]);
    expect(report.requiredVerifications.map((item) => item.target)).toEqual(["stale", "blocked"]);
    expect(report.requiredAgentActions).toEqual(["inspect code", "check permissions"]);
  });

  it("maps block_if_unverified to stale_blocked only in enforced mode", async () => {
    clearFreshnessCache();
    const getTimestamps: FreshnessTimestampFn = async () => ({ modelTouchedAt: 1, codeTouchedAt: 2 });
    const base = {
      cwd: "/repo",
      headSha: "abc",
      policies,
      getTimestamps,
      subjects: [subject("permissions", "blocked.yaml", "permission_sensitive")],
    };

    await expect(checkFreshness({ ...base, mode: "advisory" })).resolves.toMatchObject({
      status: "partially_stale",
    });
    await expect(checkFreshness({ ...base, mode: "enforced" })).resolves.toMatchObject({
      status: "stale_blocked",
    });
    await expect(checkFreshness({ ...base, mode: "enforced", verifiedTargets: ["permissions"] })).resolves.toMatchObject({
      status: "partially_stale",
      requiredVerifications: [],
    });
  });

  it("caches timestamp calls per cwd and HEAD", async () => {
    clearFreshnessCache();
    let calls = 0;
    const getTimestamps: FreshnessTimestampFn = async () => {
      calls += 1;
      return { modelTouchedAt: 2, codeTouchedAt: 1 };
    };
    const input = {
      cwd: "/repo",
      headSha: "abc",
      mode: "advisory" as const,
      policies,
      getTimestamps,
      subjects: [subject("fresh", "fresh.yaml")],
    };

    await checkFreshness(input);
    await checkFreshness(input);
    await checkFreshness({ ...input, headSha: "def" });

    expect(calls).toBe(2);
  });
});

function subject(objectId: string, objectFile: string, policyClass = "ordinary") {
  return {
    objectId,
    objectFile,
    globs: ["server/**/*.ts"],
    freshnessClass: "code_coupled" as const,
    policyClass,
  };
}
