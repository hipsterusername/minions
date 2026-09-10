import { cp, mkdtemp, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { processExecutor } from "../../src/graders/executor.js";
import { preparePublicFixture } from "../../src/isolation/public-fixture.js";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskDefinitionSchema } from "../../schemas/index.js";

const root = resolve(import.meta.dirname, "../..");
const ids = ["pagination-simple", "worker-recovery-complex", "status-filter-simple", "project-archive-complex", "orders-report-simple", "reconciliation-complex"] as const;

async function task(id: string) {
  const fixture = await import(`../../tasks/${id}/fixture.mjs`);
  const oracle = await import(`../../ground-truth/${id}/oracle.mjs`);
  return { fixture, oracle };
}

describe("initial benchmark task packages", () => {
  it("has six schema-valid public manifests with no oracle path in participant assets", async () => {
    for (const id of ids) {
      const manifest = JSON.parse(await readFile(resolve(root, "tasks", id, "manifest.json"), "utf8"));
      expect(TaskDefinitionSchema.parse(manifest).id).toBe(id);
      const prompt = await readFile(resolve(root, "tasks", id, "prompt.md"), "utf8");
      expect(prompt).not.toMatch(/ground-truth|hiddenCases|oracle\.mjs/i);
      expect(manifest.fixture.configFile).toBe("fixture.mjs");
    }
  });

  for (const id of ids) it(`${id}: executes reference and starter through the common executor`, async () => {
    const {oracle} = await task(id);
    const manifest = TaskDefinitionSchema.parse(JSON.parse(await readFile(join(root,'tasks',id,'manifest.json'),'utf8')));
    for (const reference of [true,false]) {
      const directory = await mkdtemp(join(tmpdir(),'eval-six-'));
      try {
        await preparePublicFixture(manifest,join(root,'tasks',id),directory,'integration-public');
        if (reference) await cp(join(root,'ground-truth',id,'reference'),directory,{recursive:true});
        if (id === 'project-archive-complex') await symlink(join(root,'node_modules'),join(directory,'node_modules'),'dir');
        let calls = 0; const executor = processExecutor(directory,manifest.limits.gradingTimeoutMs);
        const verdicts = await oracle.gradeFiles({submissionRoot:directory,seed:'integration-hidden',execute: async (request: Parameters<typeof executor>[0]) => { calls++; return executor(request); }});
        expect(calls).toBeGreaterThan(0);
        expect(verdicts.map((v: {criterionId:string}) => v.criterionId)).toEqual(manifest.criteria.map(c => c.id));
        expect(verdicts.every((v: {pass:boolean}) => v.pass),JSON.stringify(verdicts)).toBe(reference);
      } finally { await rm(directory,{recursive:true,force:true}); }
    }
  },120000);
});
