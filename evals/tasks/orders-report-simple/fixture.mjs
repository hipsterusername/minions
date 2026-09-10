import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const schemaVersion = 1;
export const taskId = "orders-report-simple";
// Explicit allowlist: no checkout, manifest, history, or controller code is exported.
export async function build(seed = 'public-example') {
  const offset = [...String(seed)].reduce((n, c) => (n + c.charCodeAt(0)) % 97, 0);
  return { schemaVersion, taskId, files: {
    'README.md': await readFile(new URL('./prompt.md', import.meta.url), 'utf8'),
    'src/index.mjs': await readFile(new URL('./starter/src/index.mjs', import.meta.url), 'utf8'),
    'example.csv': `id,created_at,amount\na,2025-01-31T23:00:00-02:00,1.10\nb,2025-01-01T00:00:00Z,${offset}.20\na,2025-02-01T00:00:00Z,3.33\nbad,nope,4\n`,
  } };
}
export async function materialize({ destination, seed = 'public-example' }) {
  const fixture = await build(seed);
  for (const [name, content] of Object.entries(fixture.files)) {
    const target = resolve(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return fixture;
}
