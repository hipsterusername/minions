/** Executed by a detached Node process. No controller memory or participant code imports. */
export const supervisorSource = String.raw`
const fs = require('node:fs');
const {spawn, spawnSync} = require('node:child_process');
const path = require('node:path');
const root = process.argv[1];
const spec = JSON.parse(fs.readFileSync(path.join(root,'launch.json'),'utf8'));
const save = (name,value) => { fs.writeFileSync(path.join(root,name+'.tmp'),JSON.stringify(value)); fs.renameSync(path.join(root,name+'.tmp'),path.join(root,name)); };
const out = fs.openSync(path.join(root,'stdout.jsonl'),'a');
const err = fs.openSync(path.join(root,'stderr.log'),'a');
let stopping = false, finished = false;
const child = spawn(spec.executable,spec.args,{cwd:spec.cwd,env:spec.env,detached:true,stdio:['ignore',out,err]});
save('process.json',{supervisorPid:process.pid,pid:child.pid ?? null,startedAt:new Date().toISOString()});
const kill = signal => { if (child.pid) { try {process.kill(-child.pid,signal);} catch {} } };
const stop = () => {
  if (stopping) return; stopping = true;
  if (spec.containerName) spawnSync('docker',['kill',spec.containerName],{stdio:'ignore'});
  kill('SIGTERM');
  setTimeout(()=>kill('SIGKILL'),500);
};
process.on('SIGTERM',stop); process.on('SIGINT',stop);
const timer = setInterval(()=>{if(fs.existsSync(path.join(root,'stop.json')) || fs.fstatSync(out).size+fs.fstatSync(err).size > (spec.maxLogBytes ?? 1048576)) stop();},50);
child.on('error',error=>finish('infra_error',null,String(error)));
child.on('close',code=>finish(stopping?'cancelled':code===0?'completed':'failed',code,null));
function finish(outcome,code,error) {
  if(finished)return; finished=true; clearInterval(timer);
  // A successful root must not leave background participants alive.
  kill('SIGKILL');
  save('exit.json',{outcome,code,error,endedAt:new Date().toISOString()});
}
`;
