import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePublicFixture } from '../isolation/public-fixture.js';
import { processExecutor } from '../graders/executor.js';
import type { TaskDefinition } from '../../schemas/index.js';
/** Source-based ground truth verification; never imports submission functions. */
export async function verifyOracle(task:TaskDefinition,packageRoot:string) {
  const oracle=await import(pathToFileURL(resolve(packageRoot,'tasks',task.id,task.grader.configFile)).href);
  if (typeof oracle.gradeFiles!=='function') throw new Error(`${task.id}: missing gradeFiles executor contract`);
  for (const variant of ['reference','starter']) {
    const directory=await mkdtemp(join(tmpdir(),'agent-evals-oracle-'));
    try {
      await preparePublicFixture(task,join(packageRoot,'tasks',task.id),directory,'oracle-public-v1');
      if (variant==='reference') await cp(join(packageRoot,'ground-truth',task.id,'reference'),directory,{recursive:true});
      if (task.requiredCapabilities.includes('browser')) await symlink(join(packageRoot,'node_modules'),join(directory,'node_modules'),'dir');
      let calls=0; const executor=processExecutor(directory,task.limits.gradingTimeoutMs);
      const verdicts=await oracle.gradeFiles({submissionRoot:directory,seed:'oracle-validation-v1',execute:async (request:Parameters<typeof executor>[0])=>{calls++;return executor(request);}});
      if (!calls || !Array.isArray(verdicts) || task.criteria.some(c=>!verdicts.some(v=>v.criterionId===c.id)) || verdicts.every(v=>v.pass) !== (variant==='reference')) throw new Error(`${task.id} ${variant} oracle verification failed: ${JSON.stringify(verdicts)}`);
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
  return {taskId:task.id,oracle:task.grader.id,revision:task.grader.revision,reference:'passed',starter:'rejected',executor:'local-process',controlledMeasurement:false};
}
