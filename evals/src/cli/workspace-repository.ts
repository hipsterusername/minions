import { processExecutor } from '../graders/executor.js';

/** Give every real participant the same fixture-local, committed source baseline.
 * Directory existence is insufficient: sandbox ancestors may contain empty .git
 * placeholders that the application's project registration considers repositories.
 */
export async function prepareWorkspaceRepository(workspace:string, docker?:{containerName:string;workdir:string}) {
  const execute=processExecutor(workspace,10000,docker);
  for (const args of [
    ['init'], ['add','--all'],
    ['-c','user.name=Evaluator','-c','user.email=eval@example.invalid','-c','commit.gpgSign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','--no-verify','-m','Evaluation fixture baseline'],
  ]) {
    const result=await execute({command:'git',args});
    if(result.code!==0)throw new Error('fixture Git preparation failed: '+result.stderr.slice(0,500));
  }
}
