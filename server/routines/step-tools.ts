/**
 * Step-completion MCP tool for routine-spawned Leader sessions.
 *
 * The scheduler hands a `StepRunner` an SDK loop that should report
 * outcome + summary + outputs back to the runner. We expose this to the
 * agent as a single MCP tool, `report_phase_result`, so the contract is
 * agent-native (a tool call), not text-pattern-extracted.
 *
 * Why a module-level registry of pending step contexts
 * ────────────────────────────────────────────────────
 *   The leader MCP server is constructed inside `leader.getToolGroups()`
 *   which only sees `AgentTypeContext.sessionKey`. We need to expose extra
 *   tools to *just* routine-spawned leaders without changing the
 *   `AgentTypeContext` shape for everyone. A small in-process map keyed by
 *   sessionKey is the lowest-friction seam: the runner registers the
 *   session before spawning, the leader's MCP factory checks the map,
 *   and the runner unregisters when the step completes (success or error).
 *
 *   Tests can reset the registry directly via `__resetStepContextsForTests`.
 */

import { z } from "zod/v4";
import type { NormalizedToolDef } from "../harness/types.ts";
import type {
  Artifact,
  StepOutcome,
} from "../../shared/routines/types.ts";

/** What a runner provides so the agent can report back via MCP. */
export interface StepCompletionContext {
  runId: string;
  stepId: string;
  /**
   * Resolve the step. Called from the report_phase_result tool. Multiple
   * calls are tolerated — only the first wins, subsequent calls are
   * coalesced into a tool reply that says so.
   */
  resolve(payload: {
    outcome: StepOutcome;
    summary: string;
    outputs?: Record<string, unknown>;
    artifacts?: Artifact[];
  }): void;
  /** Whether the runner has already accepted a result. */
  isSettled(): boolean;
}

const stepContexts = new Map<string, StepCompletionContext>();

/** Register a routine step's completion handler against a sessionKey. */
export function registerStepContext(
  sessionKey: string,
  ctx: StepCompletionContext,
): void {
  stepContexts.set(sessionKey, ctx);
}

/** Drop a step's completion handler — called when the runner is done. */
export function unregisterStepContext(sessionKey: string): void {
  stepContexts.delete(sessionKey);
}

/** Returns a context if this session is currently a routine step. */
export function getStepContext(
  sessionKey: string,
): StepCompletionContext | undefined {
  return stepContexts.get(sessionKey);
}

/**
 * Test seam — drop every entry. Production code never calls this.
 */
export function __resetStepContextsForTests(): void {
  stepContexts.clear();
}

/**
 * Build the tool definition that exposes `report_phase_result` to a leader
 * spawned for a routine step. Returned only when the session has a
 * registered step context; otherwise the leader uses its default tool set.
 *
 * Returns NormalizedToolDef[] which agents/leader.ts places into a toolGroup
 * keyed "routine-step". ClaudeHarness.registerTools() wraps them as a
 * named MCP server so tool calls follow the mcp__routine-step__* pattern.
 */
export function createStepToolsForSession(sessionKey: string): {
  toolDefs: NormalizedToolDef[];
  toolNames: string[];
} | null {
  const ctx = getStepContext(sessionKey);
  if (!ctx) return null;

  const reportPhaseResultDef: NormalizedToolDef = {
    name: "report_phase_result",
    description:
      "Report the result of this routine phase step. Call exactly once when " +
      "you have finished the work the routine prompt asked for. The summary " +
      "and outputs you supply will be reduced into the handoff brief that " +
      "the next phase's agents see, so be specific and structured.",
    inputSchema: z.object({
      outcome: z
        .enum(["success", "error", "aborted"])
        .default("success")
        .describe("How the step ended. Use 'error' if you cannot complete it."),
      summary: z
        .string()
        .min(1)
        .describe(
          "One-paragraph summary of what you did. Include the conclusions " +
            "the next phase needs — not a transcript.",
        ),
      outputs: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Optional structured payload (key/value pairs) that downstream " +
            "phases can address as `{{handoff.facts.<stepId>.<key>}}`.",
        ),
      artifacts: z
        .array(
          z.object({
            label: z.string().min(1),
            ref: z.string().optional(),
            excerpt: z.string().optional(),
          }),
        )
        .optional()
        .describe(
          "Optional artifacts produced (file paths, URLs). Prefer `ref` " +
            "over inlining content via `excerpt`.",
        ),
    }),
    handler: async (input: unknown) => {
      const args = input as {
        outcome: "success" | "error" | "aborted";
        summary: string;
        outputs?: Record<string, unknown>;
        artifacts?: Array<{ label: string; ref?: string; excerpt?: string }>;
      };
      if (ctx.isSettled()) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "report_phase_result was already accepted for this step; " +
                "subsequent calls are ignored. Wrap up the conversation.",
            },
          ],
        };
      }
      ctx.resolve({
        outcome: args.outcome,
        summary: args.summary,
        ...(args.outputs ? { outputs: args.outputs } : {}),
        ...(args.artifacts ? { artifacts: args.artifacts as Artifact[] } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              "Result recorded. The routine scheduler will compose the " +
              "handoff brief from this and (if applicable) start the next " +
              "phase. You can stop now.",
          },
        ],
      };
    },
  };

  return {
    toolDefs: [reportPhaseResultDef],
    toolNames: ["mcp__routine-step__report_phase_result"],
  };
}
