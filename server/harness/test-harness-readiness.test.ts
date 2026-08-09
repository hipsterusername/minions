import { afterEach, describe, expect, it } from "vitest";
import "./echo/index.ts";
import { clearHarnessReadinessCache, getHarnessReadiness } from "./readiness.ts";
import { resolveLaunchModel } from "./model-policy.ts";

describe("explicit test-harness readiness", () => {
  afterEach(() => {
    delete process.env["MINIONS_TEST_HARNESS"];
    clearHarnessReadinessCache();
  });

  it("exposes echo only when the test harness environment switch is set", async () => {
    process.env["MINIONS_TEST_HARNESS"] = "echo";
    clearHarnessReadinessCache();

    const snapshot = await getHarnessReadiness({ fresh: true });

    expect(snapshot.readyHarnesses).toContain("echo");
    expect(snapshot.harnesses.find((item) => item.name === "echo")?.ready).toBe(true);
  });

  it("resolves the model advertised by a test-only harness", () => {
    expect(
      resolveLaunchModel({
        requestedHarness: "echo",
        effectiveHarness: "echo",
        requestedModel: "echo",
        role: "leader",
      }),
    ).toEqual({ model: "echo", incompatible: false });
  });
});
