import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { freezeSubmission } from '../isolation/public-fixture.js';
import type { TaskDefinition } from '../../schemas/index.js';
export function contentHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function taskContent(task: TaskDefinition, root: string): Promise<string> {
  const publicFiles = await freezeSubmission(root, 64 * 1024 * 1024);
  const graderFiles = await freezeSubmission(dirname(resolve(root, task.grader.configFile)), 64 * 1024 * 1024);
  return contentHash({ task, publicFiles: publicFiles.files, graderFiles: graderFiles.files });
}
export function verifyLockDigest(lock: Record<string, unknown>): void { const { lockDigest, ...body } = lock; if (lockDigest !== contentHash(body)) throw new Error('locked experiment content changed'); }

/** Covers executable implementation, public schemas and the independently installed dependency lock. */
export async function implementationContent(root: string): Promise<string> {
  const trees = await Promise.all(['src', 'schemas'].map(async path => ({path, files: (await freezeSubmission(join(root,path),64*1024*1024)).files})));
  const packageFiles = await Promise.all(['package.json','pnpm-lock.yaml'].map(async path => ({path, content: await readFile(join(root,path),'utf8')})));
  return contentHash({trees,packageFiles});
}
