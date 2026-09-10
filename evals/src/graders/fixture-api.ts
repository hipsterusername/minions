/** Controller-owned recipe. Only its allowlisted files enter a participant workspace. */
export interface PublicFixture { readonly schemaVersion: 1; readonly taskId: string; readonly files: Readonly<Record<string,string>>; }
export interface FixtureRecipe {
  readonly schemaVersion: 1;
  readonly taskId: string;
  build(seed: string): Promise<PublicFixture>;
  materialize(input: {destination: string; seed: string}): Promise<PublicFixture>;
}
export interface CriterionVerdict { readonly criterionId: string; readonly pass: boolean; readonly observed: string; }
export interface FileTaskGrader { readonly schemaVersion: 1; readonly taskId: string; readonly revision: string; gradeFiles(input: { submissionRoot: string; seed: string; execute: import("./executor.js").GraderExecutor }): Promise<readonly CriterionVerdict[]>; }
export function outcome(verdicts: readonly CriterionVerdict[]): "passed" | "failed" { return verdicts.length > 0 && verdicts.every(v => v.pass) ? "passed" : "failed"; }
