import { describe, expect, it } from "vitest";
import {
  LEGACY_PLANNING_PROMPT,
  LEADER_PROMPT_CORE,
  TASK_GRAPH_PLANNING_PROMPT,
  buildLeaderPromptFeatures,
  buildLeaderCapabilityInventory,
  composeLeaderPrompt,
  decodeLeaderPromptCustomization,
  encodeLeaderPromptCustomization,
  isLeaderPromptCustomizationEnvelope,
} from "./leader-prompt.ts";

describe("leader prompt composition", () => {
  it("injects planning features from a typed registry", () => {
    expect(buildLeaderPromptFeatures(["task_graph_planning"]))
      .toEqual([TASK_GRAPH_PLANNING_PROMPT]);
    expect(buildLeaderPromptFeatures(["legacy_planning"]))
      .toEqual([LEGACY_PLANNING_PROMPT]);
    expect(buildLeaderPromptFeatures([
      "task_graph_planning", "task_graph_planning",
    ])).toEqual([TASK_GRAPH_PLANNING_PROMPT]);
  });

  it("keeps the stable core first and the volatile system-model addendum last", () => {
    const prompt = composeLeaderPrompt({
      builtInTools: ["Read"],
      registeredToolNames: ["plan_task"],
      roleSystemAddendum: "ROLE SYSTEM",
      skillsAddendum: "SKILLS",
      userPrefix: "USER PREFIX",
      systemModelAddendum: "VOLATILE MODEL",
    });

    expect(prompt.startsWith(LEADER_PROMPT_CORE)).toBe(true);
    expect(prompt.indexOf("plan_task")).toBeLessThan(prompt.indexOf("SKILLS"));
    expect(prompt.indexOf("ROLE SYSTEM")).toBeLessThan(prompt.indexOf("SKILLS"));
    expect(prompt.indexOf("SKILLS")).toBeLessThan(prompt.indexOf("USER PREFIX"));
    expect(prompt.endsWith("VOLATILE MODEL")).toBe(true);
  });

  it("documents every supplied registered tool name", () => {
    const names = [
      "message_task",
      "cancel_task",
      "checkpoint_session",
      "load_subskill",
      "publish_html",
      "wait_and_continue",
      "unknown_future_tool",
    ];
    const inventory = buildLeaderCapabilityInventory({
      builtInTools: [],
      registeredToolNames: names,
    });

    for (const name of names) expect(inventory).toContain(name);
    expect(inventory).toContain('wake_on: "any_terminal"');
  });

  it("keeps graph orchestration optional and preserves direct Leader authority", () => {
    expect(TASK_GRAPH_PLANNING_PROMPT).toMatch(/optional reasoning and orchestration aid/i);
    expect(TASK_GRAPH_PLANNING_PROMPT).toMatch(/never revokes.*direct execution/i);
    expect(TASK_GRAPH_PLANNING_PROMPT).toContain("plan_task");
    expect(TASK_GRAPH_PLANNING_PROMPT).toContain("assign_task");
    expect(TASK_GRAPH_PLANNING_PROMPT).toMatch(/do not submit one merely.*ceremony/i);
    expect(TASK_GRAPH_PLANNING_PROMPT).not.toMatch(/sole child-allocation authority/i);
  });

  it("defines all three continuity tags without conflating restart and continuation", () => {
    expect(LEADER_PROMPT_CORE).toContain("<previous-session-context>");
    expect(LEADER_PROMPT_CORE).toContain("<session-continuation>");
    expect(LEADER_PROMPT_CORE).toContain("<context-window-recovery>");
    expect(LEADER_PROMPT_CORE).toMatch(/session-continuation[\s\S]*Do not re-register/i);
    expect(LEADER_PROMPT_CORE).toMatch(/previous-session-context[\s\S]*re-register/i);
  });

  it("defines session names as durable, concise purpose labels", () => {
    expect(LEADER_PROMPT_CORE).toContain("## Session Naming");
    expect(LEADER_PROMPT_CORE).toMatch(/durable label[\s\S]*overall objective/i);
    expect(LEADER_PROMPT_CORE).toMatch(/3–6 words[\s\S]*concrete purpose/i);
    expect(LEADER_PROMPT_CORE).toMatch(/Keep the name stable[\s\S]*core objective materially changes/i);
    expect(LEADER_PROMPT_CORE).toContain("Working on tests");
    expect(LEADER_PROMPT_CORE).toContain("Harden session naming workflow");
  });

  it("round-trips only the user prefix from the structured client preview", () => {
    const wire = encodeLeaderPromptCustomization({
      promptPrefix: "  User guidance  ",
      skillsAddendum: "FROZEN SKILL INSTRUCTIONS",
    });
    expect(wire).toContain("FROZEN SKILL INSTRUCTIONS");
    expect(isLeaderPromptCustomizationEnvelope(wire)).toBe(true);
    expect(isLeaderPromptCustomizationEnvelope("full client prompt")).toBe(false);
    expect(decodeLeaderPromptCustomization(wire)).toEqual({
      promptPrefix: "User guidance",
      skillsAddendum: "FROZEN SKILL INSTRUCTIONS",
    });
    expect(decodeLeaderPromptCustomization("  raw prefix  ")).toEqual({
      promptPrefix: "raw prefix",
      skillsAddendum: "",
    });
  });
});
