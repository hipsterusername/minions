import { registerSkill } from "../registry.ts";
import { codeReviewSkill } from "./code-review.ts";
import { testGeneratorSkill } from "./test-generator.ts";
import { refactorSkill } from "./refactor.ts";
import { documentationSkill } from "./documentation.ts";
import { debugSkill } from "./debug.ts";
import { explainSkill } from "./explain.ts";
import { commitSkill } from "./commit.ts";

export function registerBuiltinSkills(): void {
  registerSkill(codeReviewSkill, { builtIn: true });
  registerSkill(testGeneratorSkill, { builtIn: true });
  registerSkill(refactorSkill, { builtIn: true });
  registerSkill(documentationSkill, { builtIn: true });
  registerSkill(debugSkill, { builtIn: true });
  registerSkill(explainSkill, { builtIn: true });
  registerSkill(commitSkill, { builtIn: true });
}

// Side-effect registration
registerBuiltinSkills();
