// Run with: node --expose-gc --import ./scripts/register-typescript.mjs tests/stability/archive.mjs
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { openPersistDb } from '../../server/session-persist.ts';
import { readHistoryPage } from '../../server/session-history.ts';
import { HistoryBuffer, historyCacheStats } from '../../server/history-cache.ts';
import { createArchiveFixture } from './archive-fixture.mjs';
assert.equal(typeof global.gc, 'function', 'Run this regression with --expose-gc');
const { file, cleanup } = createArchiveFixture();
try {
  const db = openPersistDb(file);
  const keys = db.prepare('SELECT session_key FROM sessions ORDER BY session_key').all().map(r=>r.session_key);
  const buffers = keys.map(()=>new HistoryBuffer());
  const samples=[];
  for (let pass=0;pass<5;pass++) {
    let count=0;
    for(let i=0;i<keys.length;i++) {
      let before; const ids=[];
      do {
        const page=readHistoryPage(db,keys[i],before);
        assert.ok(Buffer.byteLength(JSON.stringify(page))<=512*1024);
        buffers[i].replace(page.events);
        ids.unshift(...page.events.map(e=>e.historyId)); before=page.history.before;
      } while(before);
      assert.equal(ids.length,80); assert.equal(new Set(ids).size,80);
      assert.deepEqual(ids,[...ids].sort((a,b)=>a-b)); count+=ids.length;
    }
    await tick(); global.gc(); await tick(); global.gc();
    const stats=historyCacheStats(); assert.ok(stats.bytes<=16*1024*1024);assert.ok(stats.events<=32000);
    samples.push({pass,count,heapMiB:process.memoryUsage().heapUsed/2**20,rssMiB:process.memoryUsage().rss/2**20,...stats});
  }
  assert.ok(samples.at(-1).heapMiB-samples[1].heapMiB<5,'retained heap grows after warmup');
  console.log(JSON.stringify({sessions:keys.length,samples},null,2));
} finally {
  cleanup();
}
