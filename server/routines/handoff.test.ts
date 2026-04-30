/**
 * Handoff reducer tests.
 *
 * The brief format is part of the contract — agents in the next phase
 * read it. We assert section presence rather than full-string snapshots
 * so prose can evolve without breaking the suite, but assert that every
 * section the schema promises is actually emitted.
 */

import { describe, expect, it } from "vitest";
import { reducePhase } from "./handoff.ts";
import {
  parseRoutine,
  type PhaseResult,
  type RoutinePhase,
  type StepResult,
} from "../../shared/routines/types.ts";

const phase: RoutinePhase = parseRoutine({
  id: "research",
  name: "Research",
  phases: [
    {
      id: "research",
      label: "Research",
      description: "Gather background context",
      steps: [
        {
          id: "web",
          label: "Web research",
          routinePrompt: "Research {{inputs.topic}} on the open web.",
        },
        {
          id: "repo",
          label: "Repo research",
          routinePrompt: "Find prior art for {{inputs.topic}} in this repo.",
        },
      ],
    },
  ],
}).phases[0]!;

function makeResult(overrides: Partial<StepResult>): StepResult {
  return {
    stepId: "web",
    outcome: "success",
    summary: "ok",
    outputs: {},
    artifacts: [],
    ...overrides,
  };
}

describe("reducePhase", () => {
  it("composes a HandoffPayload with brief, facts, and per-step summaries", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({
          stepId: "web",
          summary: "Found 5 sources on widgets.",
          outputs: { sourceCount: 5, topSource: "wikipedia.org" },
          artifacts: [
            { label: "raw-results", ref: "/tmp/web.json", excerpt: "..." },
          ],
        }),
        makeResult({
          stepId: "repo",
          summary: "No prior art found.",
          outputs: { matches: 0 },
        }),
      ],
    };
    const handoff = reducePhase({
      phase,
      result,
      inputs: { topic: "widgets" },
    });
    expect(handoff.fromPhaseId).toBe("research");
    // facts are namespaced by stepId so two steps can use the same key.
    expect(handoff.facts).toEqual({
      "web.sourceCount": 5,
      "web.topSource": "wikipedia.org",
      "repo.matches": 0,
    });
    expect(Object.keys(handoff.steps).sort()).toEqual(["repo", "web"]);
    expect(handoff.steps["web"]!.summary).toBe("Found 5 sources on widgets.");
    expect(handoff.steps["web"]!.outcome).toBe("success");
  });

  it("brief includes phase header, inputs, agent enumeration, shared context", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({ stepId: "web", summary: "A" }),
        makeResult({ stepId: "repo", summary: "B" }),
      ],
    };
    const { brief } = reducePhase({
      phase,
      result,
      inputs: { topic: "widgets", depth: 3 },
    });
    expect(brief).toContain("# Handoff from phase: Research");
    expect(brief).toContain("_Gather background context_");
    expect(brief).toContain("## Inputs");
    expect(brief).toContain("**topic:** widgets");
    expect(brief).toContain("**depth:** 3");
    expect(brief).toContain("## Agent outputs");
    expect(brief).toContain("### Web research (`web`)");
    expect(brief).toContain("### Repo research (`repo`)");
    expect(brief).toContain("**Task:** Research {{inputs.topic}}");
    expect(brief).toContain("**Outcome:** success");
    expect(brief).toContain("## Shared context");
    expect(brief).toContain("phase `research`");
  });

  it("renders steps in declared order regardless of result ordering", () => {
    // Pass results in reverse to confirm reorder.
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({ stepId: "repo", summary: "B" }),
        makeResult({ stepId: "web", summary: "A" }),
      ],
    };
    const { brief } = reducePhase({
      phase,
      result,
      inputs: { topic: "x" },
    });
    const webIdx = brief.indexOf("### Web research");
    const repoIdx = brief.indexOf("### Repo research");
    expect(webIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeGreaterThan(webIdx);
  });

  it("omits the Inputs section when there are no inputs", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({ stepId: "web", summary: "" }),
        makeResult({ stepId: "repo", summary: "" }),
      ],
    };
    const { brief } = reducePhase({ phase, result, inputs: {} });
    expect(brief).not.toContain("## Inputs");
  });

  it("placeholder-marks empty step summaries instead of leaving them blank", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({ stepId: "web", summary: "" }),
        makeResult({ stepId: "repo", summary: "ok" }),
      ],
    };
    const { brief } = reducePhase({
      phase,
      result,
      inputs: { topic: "x" },
    });
    expect(brief).toContain("**Summary:** _(no summary reported)_");
  });

  it("renders artifacts with optional ref + excerpt", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({
          stepId: "web",
          summary: "ok",
          artifacts: [
            { label: "results", ref: "/tmp/r.json", excerpt: "5 hits" },
            { label: "no-ref" },
          ],
        }),
        makeResult({ stepId: "repo", summary: "ok" }),
      ],
    };
    const { brief } = reducePhase({
      phase,
      result,
      inputs: { topic: "x" },
    });
    expect(brief).toContain("**Artifacts:**");
    expect(brief).toContain("- results — `/tmp/r.json`");
    expect(brief).toContain("> 5 hits");
    expect(brief).toContain("- no-ref");
  });

  it("includes the error message when a step reports outcome=error", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({
          stepId: "web",
          outcome: "error",
          summary: "Failed to fetch",
          error: "ECONNREFUSED at example.com",
        }),
        makeResult({ stepId: "repo", summary: "ok" }),
      ],
    };
    const { brief } = reducePhase({
      phase,
      result,
      inputs: { topic: "x" },
    });
    expect(brief).toContain("**Outcome:** error");
    expect(brief).toContain("**Error:** ECONNREFUSED at example.com");
  });

  it("throws when a phase result is missing a declared step", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [makeResult({ stepId: "web", summary: "alone" })],
    };
    expect(() =>
      reducePhase({ phase, result, inputs: { topic: "x" } }),
    ).toThrow(/missing result for step "repo"/);
  });

  it("collapses multi-line summaries to a single line in the brief", () => {
    const result: PhaseResult = {
      phaseId: "research",
      steps: [
        makeResult({
          stepId: "web",
          summary: "Line one\n\nLine two\n   line three",
        }),
        makeResult({ stepId: "repo", summary: "ok" }),
      ],
    };
    const { brief } = reducePhase({
      phase,
      result,
      inputs: { topic: "x" },
    });
    expect(brief).toContain("**Summary:** Line one Line two line three");
  });
});
