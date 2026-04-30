/**
 * Template substitution tests.
 *
 * The template language is a load-bearing part of the contract — prompt
 * authors will rely on these paths existing and these paths only.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template.ts";
import type { HandoffPayload } from "../../shared/routines/types.ts";

const handoff: HandoffPayload = {
  fromPhaseId: "research",
  brief: "## brief\n- one\n- two",
  facts: {
    "web.sourceCount": 5,
    "web.topSource": "wiki",
    "repo.matches": 0,
  },
  steps: {
    web: {
      summary: "Found 5 sources.",
      outcome: "success",
      outputs: { sourceCount: 5 },
    },
    repo: {
      summary: "No prior art.",
      outcome: "success",
      outputs: {},
    },
  },
};

describe("renderTemplate — paths", () => {
  it("substitutes inputs", () => {
    const r = renderTemplate("Topic is {{inputs.topic}}.", {
      inputs: { topic: "widgets" },
    });
    expect(r.text).toBe("Topic is widgets.");
    expect(r.unresolved).toEqual([]);
  });

  it("substitutes handoff.brief", () => {
    const r = renderTemplate("Brief:\n{{handoff.brief}}", {
      inputs: {},
      handoff,
    });
    expect(r.text).toContain("## brief");
    expect(r.text).toContain("- one");
  });

  it("substitutes handoff.facts.<step>.<key>", () => {
    const r = renderTemplate(
      "Sources: {{handoff.facts.web.sourceCount}} from {{handoff.facts.web.topSource}}",
      { inputs: {}, handoff },
    );
    expect(r.text).toBe("Sources: 5 from wiki");
  });

  it("substitutes handoff.steps.<step>.summary and .outcome", () => {
    const r = renderTemplate(
      "Web said: {{handoff.steps.web.summary}} ({{handoff.steps.web.outcome}})",
      { inputs: {}, handoff },
    );
    expect(r.text).toBe("Web said: Found 5 sources. (success)");
  });

  it("substitutes phase + step metadata", () => {
    const r = renderTemplate("In {{phase.label}}, running {{step.id}}", {
      inputs: {},
      phase: { id: "p1", label: "Research" },
      step: { id: "web", label: "Web research" },
    });
    expect(r.text).toBe("In Research, running web");
  });

  it("renders numbers and booleans as their string form", () => {
    const r = renderTemplate(
      "depth={{inputs.depth}} verbose={{inputs.verbose}}",
      { inputs: { depth: 3, verbose: true } },
    );
    expect(r.text).toBe("depth=3 verbose=true");
  });
});

describe("renderTemplate — misses", () => {
  it("renders unknown paths as empty and surfaces them in unresolved", () => {
    const r = renderTemplate("A={{inputs.missing}} B={{handoff.brief}}", {
      inputs: {},
    });
    expect(r.text).toBe("A= B=");
    expect(r.unresolved.sort()).toEqual(["handoff.brief", "inputs.missing"]);
  });

  it("flags unknown roots", () => {
    const r = renderTemplate("{{nonsense.x}}", { inputs: {} });
    expect(r.text).toBe("");
    expect(r.unresolved).toEqual(["nonsense.x"]);
  });

  it("flags malformed path lengths", () => {
    const r = renderTemplate(
      "{{inputs}} {{phase.id.extra}} {{handoff.steps.web}}",
      { inputs: {}, phase: { id: "p", label: "P" }, handoff },
    );
    // All three should be unresolved (wrong arity for their root).
    expect(r.unresolved.sort()).toEqual([
      "handoff.steps.web",
      "inputs",
      "phase.id.extra",
    ]);
  });

  it("does not throw when handoff is absent", () => {
    const r = renderTemplate("{{handoff.brief}}", { inputs: {} });
    expect(r.text).toBe("");
    expect(r.unresolved).toEqual(["handoff.brief"]);
  });
});

describe("renderTemplate — depends paths (DAG mode)", () => {
  const depends = {
    steps: {
      "step-a": { summary: "A done", outcome: "success", outputs: { count: 7 } },
      "step-b": { summary: "B done", outcome: "error", outputs: {} },
    },
    facts: { "step-a.count": 7, "step-a.label": "hello" },
  };

  it("substitutes {{depends.<stepId>.summary}}", () => {
    const r = renderTemplate("From A: {{depends.step-a.summary}}", {
      inputs: {},
      depends,
    });
    expect(r.text).toBe("From A: A done");
    expect(r.unresolved).toEqual([]);
  });

  it("substitutes {{depends.<stepId>.outcome}}", () => {
    const r = renderTemplate("B outcome: {{depends.step-b.outcome}}", {
      inputs: {},
      depends,
    });
    expect(r.text).toBe("B outcome: error");
  });

  it("substitutes {{depends.facts.<stepId>.<key>}}", () => {
    const r = renderTemplate("count={{depends.facts.step-a.count}}", {
      inputs: {},
      depends,
    });
    expect(r.text).toBe("count=7");
  });

  it("renders empty and surfaces unresolved for an unknown dep step", () => {
    const r = renderTemplate("{{depends.nonexistent.summary}}", {
      inputs: {},
      depends,
    });
    expect(r.text).toBe("");
    expect(r.unresolved).toEqual(["depends.nonexistent.summary"]);
  });

  it("renders empty and surfaces unresolved when depends context is absent", () => {
    const r = renderTemplate("{{depends.step-a.summary}}", { inputs: {} });
    expect(r.text).toBe("");
    expect(r.unresolved).toEqual(["depends.step-a.summary"]);
  });

  it("renders empty for unknown depends.facts key", () => {
    const r = renderTemplate("{{depends.facts.step-a.missing}}", {
      inputs: {},
      depends,
    });
    expect(r.text).toBe("");
    expect(r.unresolved).toEqual(["depends.facts.step-a.missing"]);
  });
});

describe("renderTemplate — edge cases", () => {
  it("tolerates whitespace inside the braces", () => {
    const r = renderTemplate("{{ inputs.topic }}", {
      inputs: { topic: "x" },
    });
    expect(r.text).toBe("x");
  });

  it("leaves text without placeholders untouched", () => {
    const r = renderTemplate("Plain text, no braces.", { inputs: {} });
    expect(r.text).toBe("Plain text, no braces.");
    expect(r.unresolved).toEqual([]);
  });

  it("substitutes the same path multiple times", () => {
    const r = renderTemplate("{{inputs.x}}-{{inputs.x}}-{{inputs.x}}", {
      inputs: { x: "a" },
    });
    expect(r.text).toBe("a-a-a");
  });
});
