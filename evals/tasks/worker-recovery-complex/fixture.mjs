import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
export const schemaVersion = 1;
export const taskId = 'worker-recovery-complex';
// Public allowlist only: never copy a checkout or controller implementation.
export async function build(seed = 'public-example') {
  const offset = [...String(seed)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 10007, 0);
  const jobs = Array.from({length: 3}, (_, i) => ({id: `job-${offset}-${i}`, value: offset + i,
    failures: i, status: 'ready', attempts: 0, availableAt: 0, leaseUntil: null}));
  return { schemaVersion, taskId, files: {
    'README.md': await readFile(new URL('./prompt.md', import.meta.url), 'utf8'),
    'src/index.mjs': await readFile(new URL('./starter/src/index.mjs', import.meta.url), 'utf8'),
    'example.json': JSON.stringify({jobs, effects: []}) + '\n',
  }};
}
export async function materialize({ destination, seed = 'public-example' }) {
  const fixture = await build(seed);
  for (const [name, content] of Object.entries(fixture.files)) {
    const target = resolve(destination, name);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, content);
  }
  return fixture;
}
