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

  it("parses list maps containing nested lists", () => {
    expect(parseYamlSubset(`entry_points:\n  - surface: surface.mobile\n    files:\n      - src/mobile/**\n    flows:\n      - flow.open_workspace\n`).value).toEqual({
      entryPoints: [{
        surface: "surface.mobile",
        files: ["src/mobile/**"],
        flows: ["flow.open_workspace"],
      }],
    });
  });
});
