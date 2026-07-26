import { describe, expect, it } from "vitest";
import {
  LEADER_PROMPT_CORE,
  buildLeaderCapabilityInventory,
  composeLeaderPrompt,
  decodeLeaderPromptCustomization,
  encodeLeaderPromptCustomization,
  isLeaderPromptCustomizationEnvelope,
} from "./leader-prompt.ts";

describe("leader prompt composition", () => {
  it("keeps the stable core first and the volatile system-model addendum last", () => {
    const prompt = composeLeaderPrompt({
      builtInTools: ["Read"],
      registeredToolNames: ["plan_task"],
      skillsAddendum: "SKILLS",
      userPrefix: "USER PREFIX",
      systemModelAddendum: "VOLATILE MODEL",
    });

    expect(prompt.startsWith(LEADER_PROMPT_CORE)).toBe(true);
    expect(prompt.indexOf("plan_task")).toBeLessThan(prompt.indexOf("SKILLS"));
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

  it("defines all three continuity tags without conflating restart and continuation", () => {
    expect(LEADER_PROMPT_CORE).toContain("<previous-session-context>");
    expect(LEADER_PROMPT_CORE).toContain("<session-continuation>");
    expect(LEADER_PROMPT_CORE).toContain("<context-window-recovery>");
    expect(LEADER_PROMPT_CORE).toMatch(/session-continuation[\s\S]*Do not re-register/i);
    expect(LEADER_PROMPT_CORE).toMatch(/previous-session-context[\s\S]*re-register/i);
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
