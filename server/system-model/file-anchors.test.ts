import { describe, expect, it } from "vitest";
import { loadSystemModel } from "./load.ts";
import { validateFileAnchors } from "./file-anchors.ts";

describe("file anchor validation", () => {
  it("checks test hints, decision evidence and gate tests while accepting matched globs", () => {
    const model = loadSystemModel("tests/fixtures/system-model/valid").model!;
    model.capabilities[0]!.suggestedFiles = ["server/*.ts"];
    model.capabilities[0]!.suggestedTests = ["server/missing.test.ts"];
    model.decisions[0]!.evidence = ["server/missing-decision.ts"];
    model.policies.reviewGates[0]!.requiredChecks = [{ kind: "test", target: "server/missing-gate.test.ts" }];
    const issues = validateFileAnchors(model, ["server/new-file.ts"]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "suggestedTests", message: "File anchor matches no existing file: server/missing.test.ts" }),
      expect.objectContaining({ path: "evidence", message: "File anchor matches no existing file: server/missing-decision.ts" }),
      expect.objectContaining({ path: "requiredChecks", message: "File anchor matches no existing file: server/missing-gate.test.ts" }),
    ]));
    expect(issues.some((issue) => issue.message.endsWith("server/*.ts"))).toBe(false);
  });
});
