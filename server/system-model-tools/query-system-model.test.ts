import { describe, expect, it } from "vitest";
import { loadSystemModel } from "../system-model/load.ts";
import { createQuerySystemModelToolDef } from "./query-system-model.ts";
import { copyValidFixture } from "../system-model/load.test.ts";

describe("query_system_model", () => {
  it("returns matches with linked objects and records usage", async () => {
    const project = copyValidFixture();
    const { model } = loadSystemModel(project);
    const def = createQuerySystemModelToolDef({
      leaderSessionKey: "leader-1",
      projectPath: project,
      runtime: { mode: "advisory", manifestFound: true, model, loadErrors: [] },
    });

    const result = await def.handler({ query: "workspace", objectTypes: ["capability"] });
    const payload = JSON.parse(result.content[0]!.text) as {
      matches: Array<{ id: string }>;
      linked: Array<{ id: string }>;
    };

    expect(payload.matches.map((item) => item.id)).toEqual(["capability.workspace_management"]);
    expect(payload.linked.map((item) => item.id)).toContain("constraint.bus_only");
  });
});
