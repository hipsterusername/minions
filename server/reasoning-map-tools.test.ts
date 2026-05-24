import { describe, expect, it, vi } from "vitest";
import { createReasoningMapToolsForLeader } from "./reasoning-map-tools.ts";
import type { NormalizedToolDef } from "./harness/types.ts";

function findTool(
  toolDefs: ReadonlyArray<NormalizedToolDef>,
  name: string,
): NormalizedToolDef {
  const tool = toolDefs.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function call(tool: NormalizedToolDef, input: unknown) {
  return tool.handler(input);
}

function parse(result: Awaited<ReturnType<typeof call>>) {
  return JSON.parse(result.content[0]!.text);
}

describe("reasoning-map-tools", () => {
  it("creates a map and persists on mutation", async () => {
    const onStateChange = vi.fn();
    const onDashboardUpdate = vi.fn();
    const { toolDefs, reasoningMapState } = createReasoningMapToolsForLeader({
      onStateChange,
      onDashboardUpdate,
    });

    const result = await call(findTool(toolDefs, "create_reasoning_map"), {
      title: "Risky refactor",
      outcome: {
        title: "Refactor safely",
        summary: "Keep behavior while changing structure.",
        successSignal: "Focused tests pass.",
      },
    });

    expect(parse(result).mapId).toBe("reasoning-map-1");
    expect(reasoningMapState.activeMapId).toBe("reasoning-map-1");
    expect(onStateChange).toHaveBeenCalledWith(reasoningMapState);
    expect(onDashboardUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "reasoning-map-dashboard",
        type: "section",
        title: "Reasoning Graph",
      }),
    ]);
  });

  it("rejects invalid ops without mutating state", async () => {
    const { toolDefs, reasoningMapState } = createReasoningMapToolsForLeader({});
    await call(findTool(toolDefs, "create_reasoning_map"), {
      title: "Debug",
      outcome: {
        title: "Works",
        summary: "Fix it.",
        successSignal: "Tests pass.",
      },
    });

    const beforeCount = reasoningMapState.maps[0]!.nodes.length;
    const result = await call(findTool(toolDefs, "apply_reasoning_ops"), {
      ops: [
        {
          op: "add_node",
          node: {
            id: "hyp",
            type: "hypothesis",
            title: "Missing criterion",
            summary: "This is not falsifiable.",
            state: "active",
            basis: "assumed",
            confidence: "low",
            falsifiedBy: "",
          },
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(parse(result).validation.findings).toContainEqual(
      expect.objectContaining({ code: "hypothesis_missing_falsified_by" }),
    );
    expect(reasoningMapState.maps[0]!.nodes).toHaveLength(beforeCount);
  });

  it("throws a useful error for unsupported op names", async () => {
    const { toolDefs } = createReasoningMapToolsForLeader({});
    await call(findTool(toolDefs, "create_reasoning_map"), {
      title: "Debug",
      outcome: {
        title: "Works",
        summary: "Fix it.",
        successSignal: "Tests pass.",
      },
    });

    await expect(
      call(findTool(toolDefs, "apply_reasoning_ops"), {
        ops: [{ op: "invent_new_semantics" }],
      }),
    ).rejects.toThrow("Unsupported reasoning op: invent_new_semantics");
  });

  it("records and resolves challenges", async () => {
    const { toolDefs, reasoningMapState } = createReasoningMapToolsForLeader({});
    await call(findTool(toolDefs, "create_reasoning_map"), {
      title: "Debug",
      outcome: {
        id: "outcome",
        title: "Works",
        summary: "Fix it.",
        successSignal: "Tests pass.",
      },
    });

    await call(findTool(toolDefs, "challenge_reasoning_node"), {
      nodeId: "outcome",
      userText: "That success signal is incomplete.",
      classification: "changed_requirement",
      resolution: "Added a clearer completion criterion.",
    });

    expect(reasoningMapState.maps[0]!.challenges[0]).toMatchObject({
      nodeId: "outcome",
      status: "resolved",
      classification: "changed_requirement",
    });
  });

  it("closes a valid map and clears the active map pointer", async () => {
    const { toolDefs, reasoningMapState } = createReasoningMapToolsForLeader({});
    await call(findTool(toolDefs, "create_reasoning_map"), {
      title: "Debug",
      outcome: {
        title: "Works",
        summary: "Fix it.",
        successSignal: "Tests pass.",
      },
    });

    const result = await call(findTool(toolDefs, "close_reasoning_map"), {
      summary: "No major risks remain.",
    });

    expect(parse(result).summary).toBe("No major risks remain.");
    expect(reasoningMapState.activeMapId).toBeUndefined();
    expect(reasoningMapState.maps[0]!.status).toBe("closed");
  });
});
