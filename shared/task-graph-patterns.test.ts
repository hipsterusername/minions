import { describe, expect, it } from "vitest";
import {
  TASK_GRAPH_ANALYTICAL_ARTIFACT_SCHEMAS,
  TASK_GRAPH_PATTERN_CATALOG,
  taskGraphIterationSchema,
  taskGraphPatternProvenanceSchema,
  taskGraphProblemSignatureSchema,
} from "./task-graph-patterns.ts";

describe("task graph pattern contracts", () => {
  it("publishes a unique versioned Phase A catalog", () => {
    expect(TASK_GRAPH_PATTERN_CATALOG).toHaveLength(18);
    expect(new Set(TASK_GRAPH_PATTERN_CATALOG.map((pattern) => pattern.id)).size)
      .toBe(TASK_GRAPH_PATTERN_CATALOG.length);
    expect(TASK_GRAPH_PATTERN_CATALOG.every((pattern) => pattern.version === 1)).toBe(true);
    expect(TASK_GRAPH_PATTERN_CATALOG.every((pattern) => pattern.topology
      && pattern.useWhen && pattern.avoidWhen && pattern.safetyChecks.length > 0)).toBe(true);
    expect(taskGraphPatternProvenanceSchema.parse({ id:"p07.independent_verification" }))
      .toEqual({ id:"p07.independent_verification",version:1 });
  });

  it("normalizes a bounded problem signature", () => {
    expect(taskGraphProblemSignatureSchema.parse({ taskKind:"diagnosis" })).toEqual({
      taskKind:"diagnosis",goalClarity:"explicit",procedure:"known",decomposability:"low",
      evidenceModes:"single",alternatives:"one",deepUncertainty:false,
      verificationNeed:"ordinary",
    });
  });

  it("accepts explicit static-pattern problem kinds without changing legacy defaults", () => {
    expect(taskGraphProblemSignatureSchema.parse({taskKind:"partitioned_batch"}).taskKind)
      .toBe("partitioned_batch");
    expect(taskGraphProblemSignatureSchema.parse({taskKind:"draft_refinement"}).taskKind)
      .toBe("draft_refinement");
    expect(taskGraphProblemSignatureSchema.parse({taskKind:"dialectic"}).taskKind)
      .toBe("dialectic");
    expect(taskGraphProblemSignatureSchema.parse({}).taskKind).toBe("delivery");
  });

  it("requires evidence and a stop condition for successor episodes", () => {
    expect(() => taskGraphIterationSchema.parse({
      strategy:"successor_revision",episode:2,evidenceRefs:[],
    })).toThrow(/new evidence|stop condition|reason/);
    expect(taskGraphIterationSchema.parse({
      strategy:"successor_revision",episode:2,reason:"A test falsified the first hypothesis",
      evidenceRefs:["artifact:test-result"],stopCondition:"The discriminating test passes",
    })).toMatchObject({ strategy:"successor_revision",episode:2 });
  });

  it("ships the complete analytical artifact vocabulary with accepted examples", () => {
    expect(Object.keys(TASK_GRAPH_ANALYTICAL_ARTIFACT_SCHEMAS)).toEqual([
      "EvidenceSet","HypothesisSet","TestResult","DecisionFrame","DecisionEvaluation",
      "ScenarioSet","RiskRegister","VerificationVerdict","CoverageReport","PatternOutcome",
    ]);
    for (const schema of Object.values(TASK_GRAPH_ANALYTICAL_ARTIFACT_SCHEMAS)) {
      expect(schema).toHaveProperty("type","object");
      expect(schema).toHaveProperty("example");
    }
  });
});
