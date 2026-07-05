import { describe, expect, it } from "vitest";
import { parseYamlSubset } from "./yaml-parser.ts";

describe("parseYamlSubset", () => {
  it("parses nested maps and inline lists", () => {
    expect(parseYamlSubset("root:\n  child_key: [one, two]\n").value).toEqual({
      root: { childKey: ["one", "two"] },
    });
  });

  it("reports malformed lines", () => {
    expect(parseYamlSubset("id bad\n").errors[0]).toContain("Expected key");
  });
});
