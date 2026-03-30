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
  registerSkill(codeReviewSkill, { builtIn: true });
  registerSkill(testGeneratorSkill, { builtIn: true });
  registerSkill(refactorSkill, { builtIn: true });
  registerSkill(documentationSkill, { builtIn: true });
  registerSkill(debugSkill, { builtIn: true });
  registerSkill(explainSkill, { builtIn: true });
  registerSkill(commitSkill, { builtIn: true });
  // Superpowers skills
  registerSkill(frontendDesignSkill, { builtIn: true });
  registerSkill(simplifySkill, { builtIn: true });
  registerSkill(performanceSkill, { builtIn: true });
  registerSkill(securityAuditSkill, { builtIn: true });
  registerSkill(architectSkill, { builtIn: true });
  registerSkill(apiDesignSkill, { builtIn: true });
}

// Side-effect registration
registerBuiltinSkills();
