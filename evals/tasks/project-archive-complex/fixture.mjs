import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
export const schemaVersion = 1;
export const taskId = 'project-archive-complex';
export async function build(seed = 'public-example') {
  const suffix = [...String(seed)].reduce((n,c) => (Math.imul(n,31) + c.charCodeAt(0)) >>> 0, 7);
  const files = {
    'README.md': await readFile(new URL('./prompt.md', import.meta.url), 'utf8'),
    'package.json': JSON.stringify({private:true,type:'module',engines:{node:'>=22.13'},devDependencies:{playwright:'1.62.1'}}, null, 2) + '\n',
    'example.json': JSON.stringify([{id:`p-${suffix}`,name:'Alpha',owner:'ana',description:'A public example'}]) + '\n',
  };
  for (const name of ['server.mjs','app.js','index.html']) files[`src/${name}`] = await readFile(new URL(`./starter/src/${name}`, import.meta.url), 'utf8');
  return {schemaVersion,taskId,files};
}
export async function materialize({destination,seed = 'public-example'}) {
  const fixture = await build(seed);
  for (const [name,content] of Object.entries(fixture.files)) {
    const target = resolve(destination,name); await mkdir(dirname(target),{recursive:true}); await writeFile(target,content);
  }
  return fixture;
}
