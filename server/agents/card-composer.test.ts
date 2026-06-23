import { describe, it, expect, beforeEach } from "vitest";
import type { WebSocketServer } from "ws";
import { createBus } from "../bus.ts";
import type { BusPayload } from "../bus.ts";
import { getAgentType } from "./registry.ts";
import "./card-composer.ts";

describe("card-composer agent", () => {
  let emittedCalls: Array<[string, BusPayload]>;
  let ctx: Parameters<ReturnType<typeof getAgentType>["getToolGroups"]>[0];

  beforeEach(() => {
    emittedCalls = [];
    const bus = createBus({ clients: new Set() } as unknown as WebSocketServer);
    bus.emitToSession = (sessionKey: string, payload: BusPayload) => {
      emittedCalls.push([sessionKey, payload]);
    };

    ctx = {
      sessionKey: "card-composer-1",
      cwd: "/tmp/project",
      bus,
      worktreeInfo: null,
      worktreeIsolation: false,
    };
  });

  function getCreateCardTool() {
    const result = getAgentType("card-composer").getToolGroups(ctx);
    const tools = result.toolGroups["card-composer"];
    const tool = tools?.find((t) => t.name === "create_card");
    if (!tool) throw new Error("create_card tool not found");
    return tool;
  }

  describe("valid input", () => {
    it("emits kanban_card_created with trimmed card fields", async () => {
      const tool = getCreateCardTool();
      await tool.handler({
        title: "  Build login page  ",
        description: "Create the login UI",
        context: "src/auth/",
        priority: "high",
        subtasks: ["  Add form validation  ", "  Wire API  "],
      });

      expect(emittedCalls).toHaveLength(1);
      const [sessionKey, event] = emittedCalls[0]!;
      expect(sessionKey).toBe("card-composer-1");
      expect(event.type).toBe("kanban_card_created");
      const card = (event as Record<string, unknown>).card as Record<string, unknown>;
      expect(card.title).toBe("Build login page");
      expect(card.description).toBe("Create the login UI");
      expect(card.context).toBe("src/auth/");
      expect(card.priority).toBe("high");
      expect(card.subtasks).toEqual(["Add form validation", "Wire API"]);
    });

    it("result is not an error and does NOT contain the card title", async () => {
      const tool = getCreateCardTool();
      const result = await tool.handler({
        title: "Deploy staging environment",
        description: "Set up staging",
        priority: "medium",
      });

      expect(result.isError).toBeFalsy();
      const text = result.content.map((c: { text?: string }) => c.text ?? "").join("");
      expect(text).not.toContain("Deploy staging environment");
    });

    it("applies defaults for optional fields", async () => {
      const tool = getCreateCardTool();
      await tool.handler({ title: "Minimal card" });

      expect(emittedCalls).toHaveLength(1);
      const [, event] = emittedCalls[0]!;
      const card = (event as Record<string, unknown>).card as Record<string, unknown>;
      expect(card.description).toBe("");
      expect(card.context).toBe("");
      expect(card.priority).toBe("medium");
      expect(card.subtasks).toEqual([]);
    });
  });

  describe("invalid input", () => {
    it("returns an error result with 'Invalid card payload' for empty title", async () => {
      const tool = getCreateCardTool();
      const result = await tool.handler({ title: "" });

      expect(result.isError).toBe(true);
      const text = result.content.map((c: { text?: string }) => c.text ?? "").join("");
      expect(text).toContain("Invalid card payload");
    });

    it("does NOT emit kanban_card_created on invalid input", async () => {
      const tool = getCreateCardTool();
      await tool.handler({ title: "" });

      expect(emittedCalls).toHaveLength(0);
    });

    it("returns an error result for completely missing title", async () => {
      const tool = getCreateCardTool();
      const result = await tool.handler({});

      expect(result.isError).toBe(true);
      const text = result.content.map((c: { text?: string }) => c.text ?? "").join("");
      expect(text).toContain("Invalid card payload");
    });
  });
});
