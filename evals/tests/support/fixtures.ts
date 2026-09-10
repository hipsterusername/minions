import type { TaskDefinition } from "../../schemas/index.js";

export const taskManifest: TaskDefinition = {
  schemaVersion: 1, id: "pagination-simple", revision: "r1", family: "library", difficulty: "simple",
  promptFile: "prompt.md", fixture: { builderId: "fixture.node", configFile: "fixture.json", imageDigest: "sha256:fixture" },
  requiredCapabilities: ["filesystem"], submission: { include: ["src/**"], exclude: ["node_modules/**"], maxBytes: 1024 },
  criteria: [{ id: "pagination.boundary", description: "preserves page boundaries", mandatory: true }],
  grader: { id: "grader.fixture", revision: "r1", configFile: "grader.json" },
  limits: { maxTotalTokens: 100, executionTimeoutMs: 1000, preparationTimeoutMs: 1000, gradingTimeoutMs: 1000 }
};
