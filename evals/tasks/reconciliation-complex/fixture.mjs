import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
export const schemaVersion = 1;
export const taskId = 'reconciliation-complex';
export async function build(seed = 'public-example') {
  const amount = [...String(seed)].reduce((n,c) => (n + c.charCodeAt(0)) % 97, 0);
  const files = {
    'README.md': await readFile(new URL('./prompt.md', import.meta.url), 'utf8'),
    'src/index.mjs': await readFile(new URL('./starter/src/index.mjs', import.meta.url), 'utf8'),
    'orders.json': JSON.stringify([{id:'o1',currency:'USD'}]) + '\n',
    'payments.json': JSON.stringify([{id:'p1',orderId:'o1',at:'2025-01-01T00:00:00Z',amount:`${amount}.005`,currency:'USD'}]) + '\n',
    'refunds.json': '[]\n', 'rates.json': '[]\n',
  };
  return {schemaVersion, taskId, files};
}
export async function materialize({destination, seed = 'public-example'}) {
  const fixture = await build(seed);
  for (const [name, content] of Object.entries(fixture.files)) {
    const target = resolve(destination, name);
    await mkdir(dirname(target), {recursive:true});
    await writeFile(target, content);
  }
  return fixture;
}
