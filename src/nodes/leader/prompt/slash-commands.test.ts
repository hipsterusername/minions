import { describe, expect, it } from "vitest";

import {
  buildSlashCommands,
  filterSlashCommands,
  parseSlashQuery,
  type SlashCommand,
} from "./slash-commands.ts";

describe("parseSlashQuery", () => {
  it.each([
    ["/", ""],
    ["/imp", "imp"],
    ["hello", null],
    ["/a\nb", null],
    ["/a\rb", null],
    ["", null],
  ])("parses %j as %j", (input, expected) => {
    expect(parseSlashQuery(input)).toBe(expected);
  });
});

describe("filterSlashCommands", () => {
  const commands: SlashCommand[] = [
    { id: "improve", label: "Improve", description: "", insertText: "one" },
    { id: "execute", label: "Execute", description: "", insertText: "two" },
    { id: "analyze", label: "Analyze", description: "", insertText: "three" },
  ];

  it("returns every command for an empty query", () => {
    expect(filterSlashCommands(commands, "")).toEqual(commands);
  });

  it("matches labels by case-insensitive substring", () => {
    expect(filterSlashCommands(commands, "AN").map((command) => command.id)).toEqual([
      "analyze",
    ]);
    expect(filterSlashCommands(commands, "XEC").map((command) => command.id)).toEqual([
      "execute",
    ]);
  });
});

describe("buildSlashCommands", () => {
  it("keeps Ship available when editable actions are empty", () => {
    const commands = buildSlashCommands({ dashboardLeaderActions: [] });
    expect(filterSlashCommands(commands, "SHIP")).toEqual([
      expect.objectContaining({ id: "ship", label: "Ship", icon: "rocket" }),
    ]);
  });

  it("preserves custom actions that collide with Ship feature ids", () => {
    const actions = ["ship", "ship-feature"].map((id) => ({
      id, name: `Custom ${id}`, prompt: `Run ${id}`, icon: "play", skillIds: [],
    }));
    const commands = buildSlashCommands({ dashboardLeaderActions: actions });
    expect(new Set(commands.map(({ id }) => id)).size).toBe(commands.length);
    expect(commands.slice(0, 2).map(({ insertText }) => insertText)).toEqual([
      "Run ship", "Run ship-feature",
    ]);
    expect(commands.at(-1)).toMatchObject({ id: "ship-feature-feature", label: "Ship" });
  });

  it.each(["graph", "crew", "CREW", "gra", "cr"])("resolves %s to the same Graph feature", (query) => {
    const commands = buildSlashCommands({ dashboardLeaderActions: [] });
    expect(filterSlashCommands(commands, query)).toEqual([
      expect.objectContaining({ id: "task-graph", label: "Graph", icon: "crew" }),
    ]);
  });

  it("keeps custom action ids unique when adding the Graph feature", () => {
    const commands = buildSlashCommands({ dashboardLeaderActions: [
      { id: "task-graph", name: "Custom", prompt: "Keep this recipe", icon: "play", skillIds: [] },
    ] });
    expect(new Set(commands.map(({ id }) => id)).size).toBe(commands.length);
    expect(commands[0]?.insertText).toBe("Keep this recipe");
    expect(filterSlashCommands(commands, "crew")[0]?.label).toBe("Graph");
  });

  it("resolves custom names and prompts in dashboard action order", () => {
    const commands = buildSlashCommands({
      dashboardLeaderActionNames: { improve: "Polish" },
      dashboardLeaderActionPrompts: { improve: "Make the result sharper." },
    });

    expect(commands.map((command) => command.id)).toEqual([
      "execute",
      "improve",
      "analyze",
      "task-graph",
      "ship",
    ]);
    expect(commands[1]).toEqual({
      id: "improve",
      label: "Polish",
      description: "Make the result sharper.",
      insertText: "Make the result sharper.",
      icon: "sparkles",
      skillIds: [],
    });
  });

  it("truncates long descriptions without truncating inserted prompts", () => {
    const prompt = "x".repeat(61);
    const command = buildSlashCommands({
      dashboardLeaderActionPrompts: { improve: prompt },
    }).find(({ id }) => id === "improve");

    expect(command?.description).toBe(`${"x".repeat(60)}…`);
    expect(command?.insertText).toBe(prompt);
  });
});
