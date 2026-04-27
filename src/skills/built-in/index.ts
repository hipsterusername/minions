import { registerSkill } from "../registry.ts";
import { codeReviewSkill } from "./code-review.ts";
import { testGeneratorSkill } from "./test-generator.ts";
import { refactorSkill } from "./refactor.ts";
import { documentationSkill } from "./documentation.ts";
import { debugSkill } from "./debug.ts";
import { explainSkill } from "./explain.ts";
import { commitSkill } from "./commit.ts";
import { frontendDesignSkill } from "./frontend-design.ts";
import { simplifySkill } from "./simplify.ts";
import { performanceSkill } from "./performance.ts";
import { securityAuditSkill } from "./security-audit.ts";
import { architectSkill } from "./architect.ts";
import { apiDesignSkill } from "./api-design.ts";

export function registerBuiltinSkills(): void {
  registerSkill(codeReviewSkill);
  registerSkill(testGeneratorSkill);
  registerSkill(refactorSkill);
  registerSkill(documentationSkill);
  registerSkill(debugSkill);
  registerSkill(explainSkill);
  registerSkill(commitSkill);
  // Superpowers skills
  registerSkill(frontendDesignSkill);
  registerSkill(simplifySkill);
  registerSkill(performanceSkill);
  registerSkill(securityAuditSkill);
  registerSkill(architectSkill);
  registerSkill(apiDesignSkill);
}

// Side-effect registration
registerBuiltinSkills();
