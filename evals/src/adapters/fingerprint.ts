import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { freezeSubmission } from '../isolation/public-fixture.js';
export async function executableFingerprint(executable:string) {
  const candidates=isAbsolute(executable)?[executable]:(process.env.PATH??'').split(':').map(path=>join(path,executable));
  for(const path of candidates) { try { await access(path,constants.X_OK);const file=await realpath(path);return createHash('sha256').update(await readFile(file)).digest('hex'); } catch {} }
  throw new Error('executable not found for fingerprint: '+executable);
}
export async function applicationFingerprint(root:string) {
  const trees=await Promise.all(['server','shared'].map(async path=>({path,files:(await freezeSubmission(join(root,path),128*1024*1024)).files})));
  const files=await Promise.all(['package.json','pnpm-lock.yaml'].map(async path=>({path,content:await readFile(join(root,path),'utf8')})));
  return createHash('sha256').update(JSON.stringify({trees,files})).digest('hex');
}
