import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
export const schemaVersion = 1;
export const taskId = "aider-forth";
export async function build() {
  return {schemaVersion, taskId, files: {
    'README.md': await readFile(new URL('./prompt.md', import.meta.url), 'utf8'),
    'LICENSE': await readFile(new URL('./LICENSE', import.meta.url), 'utf8'),
    'forth.mjs': await readFile(new URL('./starter/forth.mjs', import.meta.url), 'utf8'),
  }};
}
export async function materialize({destination}) {
  const fixture = await build();
  for (const [name, content] of Object.entries(fixture.files)) {
    const target = resolve(destination, name);
    await mkdir(dirname(target), {recursive:true});
    await writeFile(target, content);
  }
  return fixture;
}
