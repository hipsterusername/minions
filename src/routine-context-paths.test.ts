/**
 * Tests for routine-context-paths — pure helpers powering the palette,
 * prompt preview and flow map. Behaviour-focused: classify, extract,
 * build sections, audit.
 */
import { describe, expect, it } from "vitest";
import type { Routine } from "../shared/routines/types.ts";
import {
  auditRoutineRefs,
  buildPaletteSections,
  classifyRef,
  extractRefs,
  tallyUsage,
} from "./routine-context-paths.ts";

const ROUTINE: Routine = {
  id: "demo",
  name: "Demo",
  version: 1,
  failurePolicy: "fail-fast",
  inputs: [
    { name: "topic", type: "string", label: "Topic", required: true },
    { name: "depth", type: "number", label: "Depth", required: false },
  ],
  phases: [
    {
      id: "research",
      label: "Research",
      steps: [
        {
          id: "find",
          label: "Find sources",
          agent: "leader",
          routinePrompt: "Look into {{inputs.topic}} at depth {{inputs.depth}}.",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
        },
      ],
    },
    {
      id: "analyse",
      label: "Analyse",
      steps: [
        {
          id: "synth",
          label: "Synthesise",
          agent: "leader",
          routinePrompt:
            "Use {{handoff.brief}} and {{handoff.steps.find.summary}}.",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
        },
      ],
    },
  ],
};

describe("classifyRef", () => {
  it.each([
    ["inputs.topic", "input"],
    ["handoff.brief", "brief"],
    ["handoff.steps.x.summary", "summary"],
    ["handoff.steps.x.outcome", "outcome"],
    ["handoff.steps.x.outputs", "outputs"],
    ["handoff.steps.x.outputs.foo", "outputs"],
    ["handoff.facts.score", "facts"],
    ["handoff.facts.deep.nested.key", "facts"],
    ["something.else", "unknown"],
    ["", "unknown"],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(classifyRef(path)).toBe(kind);
  });
});

describe("extractRefs", () => {
  it("returns one token per {{path}}", () => {
    const refs = extractRefs("hello {{inputs.topic}} world {{handoff.brief}}");
    expect(refs).toHaveLength(2);
    expect(refs[0]?.path).toBe("inputs.topic");
    expect(refs[0]?.kind).toBe("input");
    expect(refs[1]?.path).toBe("handoff.brief");
    expect(refs[1]?.kind).toBe("brief");
  });

  it("trims whitespace inside braces", () => {
    expect(extractRefs("{{ inputs.topic }}")[0]?.path).toBe("inputs.topic");
  });

  it("returns empty when no refs", () => {
    expect(extractRefs("plain text")).toEqual([]);
  });

  it("emits unknown kind for malformed paths", () => {
    expect(extractRefs("{{nope}}")[0]?.kind).toBe("unknown");
  });

  it("preserves character offsets so the preview can split the string", () => {
    const text = "use {{inputs.topic}} now";
    const tok = extractRefs(text)[0]!;
    expect(text.slice(tok.start, tok.end)).toBe("{{inputs.topic}}");
  });
});

describe("buildPaletteSections", () => {
  it("phase 0 sees only inputs", () => {
    const sections = buildPaletteSections(ROUTINE, 0);
    expect(sections.map((s) => s.title)).toEqual(["Inputs"]);
    expect(sections[0]?.entries.map((e) => e.path)).toEqual([
      "inputs.topic",
      "inputs.depth",
    ]);
  });

  it("phase 1 sees inputs + handoff from phase 0", () => {
    const sections = buildPaletteSections(ROUTINE, 1);
    expect(sections.map((s) => s.title)).toEqual(["Inputs", "Research"]);
    const phase0 = sections[1]!;
    expect(phase0.entries.map((e) => e.path)).toContain("handoff.brief");
    expect(phase0.entries.map((e) => e.path)).toContain(
      "handoff.steps.find.summary",
    );
    expect(phase0.entries.map((e) => e.path)).toContain(
      "handoff.steps.find.outputs",
    );
  });

  it("skips inputs section when no inputs declared", () => {
    const r: Routine = { ...ROUTINE, inputs: [] };
    expect(buildPaletteSections(r, 1).map((s) => s.title)).toEqual([
      "Research",
    ]);
  });
});

describe("tallyUsage", () => {
  it("counts repeats", () => {
    const usage = tallyUsage("{{inputs.topic}} {{inputs.topic}} {{handoff.brief}}");
    expect(usage.get("inputs.topic")).toBe(2);
    expect(usage.get("handoff.brief")).toBe(1);
  });
});

describe("auditRoutineRefs", () => {
  it("flags inputs that are declared but never referenced", () => {
    const r: Routine = {
      ...ROUTINE,
      inputs: [
        ...ROUTINE.inputs,
        { name: "ghost", type: "string", label: "Ghost", required: false },
      ],
    };
    const audit = auditRoutineRefs(r);
    expect(audit.unusedInputs).toContain("ghost");
    expect(audit.unusedInputs).not.toContain("topic");
  });

  it("flags refs that don't resolve in the current phase context", () => {
    const r: Routine = {
      ...ROUTINE,
      phases: [
        ROUTINE.phases[0]!,
        {
          ...ROUTINE.phases[1]!,
          steps: [
            {
              ...ROUTINE.phases[1]!.steps[0]!,
              routinePrompt: "use {{handoff.steps.NOPE.summary}}",
            },
          ],
        },
      ],
    };
    const audit = auditRoutineRefs(r);
    expect(audit.unknownRefs).toHaveLength(1);
    expect(audit.unknownRefs[0]?.path).toBe("handoff.steps.NOPE.summary");
  });

  it("flags facts references in phase 0 (no upstream yet)", () => {
    const r: Routine = {
      ...ROUTINE,
      phases: [
        {
          ...ROUTINE.phases[0]!,
          steps: [
            {
              ...ROUTINE.phases[0]!.steps[0]!,
              routinePrompt: "use {{handoff.facts.score}}",
            },
          ],
        },
        ROUTINE.phases[1]!,
      ],
    };
    const audit = auditRoutineRefs(r);
    expect(audit.unknownRefs.some((u) => u.path === "handoff.facts.score")).toBe(
      true,
    );
  });

  it("accepts outputs.<key> drill-down", () => {
    const r: Routine = {
      ...ROUTINE,
      phases: [
        ROUTINE.phases[0]!,
        {
          ...ROUTINE.phases[1]!,
          steps: [
            {
              ...ROUTINE.phases[1]!.steps[0]!,
              routinePrompt: "use {{handoff.steps.find.outputs.title}}",
            },
          ],
        },
      ],
    };
    const audit = auditRoutineRefs(r);
    expect(audit.unknownRefs).toEqual([]);
  });
});
