import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrozenSubmission } from '../../schemas/index.js';
/** Bounded full-file unified hunks: deterministic, reviewable and independent of Git state. */
export async function writeChangesPatch(beforeRoot:string,before:FrozenSubmission,afterRoot:string,after:FrozenSubmission,path:string) {
  const old=new Map(before.files.map(f=>[f.path,f])), next=new Map(after.files.map(f=>[f.path,f]));const lines:string[]=[];
  for (const name of [...new Set([...old.keys(),...next.keys()])].sort()) {
    if (old.get(name)?.digest===next.get(name)?.digest)continue;
    const a=old.has(name)?await readFile(join(beforeRoot,name)):Buffer.alloc(0),b=next.has(name)?await readFile(join(afterRoot,name)):Buffer.alloc(0);
    lines.push(`diff --git ${JSON.stringify('a/'+name)} ${JSON.stringify('b/'+name)}`);
    if(a.includes(0)||b.includes(0)){lines.push(`Binary files differ: ${old.get(name)?.digest??'absent'} -> ${next.get(name)?.digest??'absent'}`);continue;}
    const split=(data:Buffer)=>data.length?data.toString('utf8').replace(/\n$/,'').split('\n'):[];
    const x=split(a),y=split(b);
    lines.push(`--- ${old.has(name)?JSON.stringify('a/'+name):'/dev/null'}`,`+++ ${next.has(name)?JSON.stringify('b/'+name):'/dev/null'}`,`@@ -${x.length?1:0},${x.length} +${y.length?1:0},${y.length} @@`);
    lines.push(...x.map(line=>'-'+line));if(a.length&&a.at(-1)!==10)lines.push('\\ No newline at end of file');
    lines.push(...y.map(line=>'+'+line));if(b.length&&b.at(-1)!==10)lines.push('\\ No newline at end of file');
  }
  await writeFile(path,lines.join('\n')+(lines.length?'\n':''),{flag:'wx'});
}
