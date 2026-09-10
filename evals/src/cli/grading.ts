import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPublicFixture } from '../isolation/public-fixture.js';
import { fileGrader, processExecutor } from '../graders/executor.js';
import type { Grader } from '../core/contracts.js';
import type { TaskDefinition } from '../../schemas/index.js';
/** Local grading still executes untrusted code, so give it a disposable copy of frozen evidence. */
export function localSubmissionGrader(task:TaskDefinition,oracle:string,submissionRoot:string,seed:string):Grader {
  return {id:task.grader.id,version:'1',async grade(input,context) {
    const directory=await mkdtemp(join(tmpdir(),'agent-evals-grade-'));
    try {
      await exportPublicFixture({sourceRoot:submissionRoot,destinationRoot:directory,include:['.'],maxBytes:task.submission.maxBytes});
      if (task.requiredCapabilities.includes('browser')) {
        // Installed library tooling only, never application modules or runtime state.
        const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),import.meta.url.includes('/dist/')?'../../..':'../..');
        await symlink(join(packageRoot,'node_modules'),join(directory,'node_modules'),'dir');
      }
      return await fileGrader(task,oracle,directory,seed,processExecutor(directory,context.timeoutMs)).grade(input,context);
    } finally { await rm(directory,{recursive:true,force:true}); }
  }};
}
