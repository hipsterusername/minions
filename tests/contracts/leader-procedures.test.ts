import { describe, expect, it } from "vitest";
import { createLeaderProcedureTools } from "../../server/leader-procedure-tools.ts";
import { LEADER_PROCEDURE_IDS, getLeaderProcedure } from "../../shared/leader-procedures.ts";
import { composeLeaderPrompt } from "../../shared/leader-prompt.ts";

describe("callable lifecycle procedures", () => {
  it("discovers and retrieves every phase without injecting bodies into launch", async () => {
    const [tool] = createLeaderProcedureTools();
    const index = await tool!.handler({});
    const prompt = composeLeaderPrompt({ builtInTools: [], registeredToolNames: [tool!.name] });
    for (const id of LEADER_PROCEDURE_IDS) {
      expect(JSON.stringify(index)).toContain(id);
      const response = await tool!.handler({ id });
      const procedure = getLeaderProcedure(id)!;
      const block = response.content.find(item => item.type === "text")!;
      expect(JSON.parse(block.text).body).toBe(procedure.body);
      expect(prompt).not.toContain(procedure.body);
    }
    expect(prompt).toContain('load_procedure');
    expect(await tool!.handler({ id: "unknown" })).toMatchObject({ isError: true });
  });
});
