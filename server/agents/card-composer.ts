/**
 * Card Composer agent type — focused job that turns a rough user draft into
 * one structured Kanban card via a required MCP tool call.
 */

import { z } from "zod/v4";
import { registerAgentType } from "./registry.ts";
import type { AgentType, AgentTypeContext, AgentToolResult } from "./types.ts";
import type { NormalizedToolDef } from "../harness/types.ts";

const CARD_COMPOSER_TOOL = "mcp__card-composer__create_card";

const prioritySchema = z.enum(["low", "medium", "high", "critical"]);

const createCardSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(100)
    .describe("Short, action-oriented card title."),
  description: z
    .string()
    .default("")
    .describe("Agent-ready outcome and scope. This becomes the Leader prompt."),
  context: z
    .string()
    .default("")
    .describe("Relevant files, constraints, assumptions, and acceptance criteria."),
  priority: prioritySchema
    .default("medium")
    .describe("Task priority. Prefer medium unless the draft explicitly implies urgency."),
  subtasks: z
    .array(z.string().min(1).max(180))
    .default([])
    .describe("Optional checklist items or acceptance criteria."),
});

function createCardTool(ctx: AgentTypeContext): NormalizedToolDef {
  return {
    name: "create_card",
    description:
      "Create exactly one structured Kanban card from the user's draft. This is the final output of the card-composer job.",
    inputSchema: createCardSchema,
    handler: async (input: unknown) => {
      const parsed = createCardSchema.safeParse(input);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Invalid card payload: ${parsed.error.message}`,
            },
          ],
        };
      }

      const card = {
        title: parsed.data.title.trim(),
        description: parsed.data.description.trim(),
        context: parsed.data.context.trim(),
        priority: parsed.data.priority,
        subtasks: parsed.data.subtasks.map((s) => s.trim()).filter(Boolean),
      };

      ctx.bus.emitToSession(ctx.sessionKey, {
        type: "kanban_card_created",
        sessionKey: ctx.sessionKey,
        card,
        timestamp: Date.now(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Created card: ${card.title}`,
          },
        ],
      };
    },
  };
}

const CARD_COMPOSER_SYSTEM_PROMPT = `You are a focused card-composer job inside a Kanban board.

Your only task is to turn the user's rough draft into one clear, agent-ready task card.

Rules:
- You MUST call create_card exactly once.
- Do not create more than one card.
- Do not do implementation work.
- Do not ask follow-up questions. Make a reasonable card from the draft.
- Preserve the user's intent. Improve structure, wording, and context.
- If the draft is short, create a useful title and concise description from it.
- Put file paths, constraints, assumptions, and acceptance criteria in context.
- Use subtasks only when they reduce ambiguity. Prefer 0-4 items.
- Prefer priority "medium" unless urgency or production impact is explicit.
- After calling create_card, stop.`;

const cardComposerAgent: AgentType = {
  id: "card-composer",

  buildSystemPrompt(_ctx: AgentTypeContext, customPrompt?: string): string {
    return customPrompt ?? CARD_COMPOSER_SYSTEM_PROMPT;
  },

  getToolGroups(ctx: AgentTypeContext): AgentToolResult {
    return {
      toolGroups: {
        "card-composer": [createCardTool(ctx)],
      },
      mcpToolNames: [CARD_COMPOSER_TOOL],
    };
  },

  wantsWorktree: false,
  detectsSubagents: false,
};

registerAgentType(cardComposerAgent);
