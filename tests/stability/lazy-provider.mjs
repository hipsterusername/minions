import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { openPersistDb, closePersistDb } from '../../server/session-persist.ts';
import { ensureWorkItemSchema } from '../../server/work-item-schema.ts';
import { createWorkItem, startWorkItemIteration } from '../../server/work-item-repo.ts';
import { createSqliteWorkItemService } from '../../server/work-item-service-sqlite.ts';
import { createWakeDeliveryStore } from '../../server/wake-delivery-store.ts';
import { SessionRegistry } from '../../server/session-registry.ts';
import { SessionHost } from '../../server/session-host.ts';
import { createBus } from '../../server/bus.ts';
import { launchSession } from '../../server/session-launch.ts';
import { requestCoalescedWake, cancelCoalescedWake, getWakeQueueStats } from '../../server/wake-coalescer.ts';

import { registerHarness } from '../../server/harness/index.ts';

for (const mode of ['lazy-throw', 'init-echo-throw', 'init-echo-error', 'completed']) {
test(`canonical wake acceptance evidence: ${mode}`, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'minions-wake-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let acknowledged = 0;
  registerHarness({ name: 'lazy-failure-verification', exposure: 'test', capabilities: { mutationInterception: 'none', thinking: false, promptCaching: false, mcp: true, permissionPrompts: false, resume: true, partialMessages: false, builtInFilesystem: false }, builtInTools: [], resolveModel: () => null, registerTools() {}, start: () => ({ events: (async function* () {
    await tick();
    if (mode !== 'lazy-throw') {
      yield {kind:'init', sessionId:'thread', model:'test'};
      yield {kind:'text', role:'user', text:'instruction echo'};
      await tick();
      assert.equal(acknowledged, 0, 'init and user echo cannot acknowledge attention');
    }
    if (mode.endsWith('throw')) throw new Error('provider setup failed before accepting instruction');
    yield {kind:'done', reason:mode === 'completed' ? 'completed' : 'error'};
  })(), control: {abort() {}} }) });
  const db = openPersistDb(':memory:'); ensureWorkItemSchema(db);
  createWorkItem(db, {id:'work', projectId:'project', projectPath:cwd, title:'wake', changeMode:'live', at:1});
  startWorkItemIteration(db, {workItemId:'work', runKey:'run', idempotencyKey:'start', expectedLifecycleRevision:0, expectedCurrentRunKey:null, at:2});
  db.prepare("UPDATE work_items SET runtime_state='waiting',wait_kind='timer' WHERE id='work'").run();
  const host = new SessionHost('run', cwd); host.workItemId='work'; host.runKind='primary'; host.role='default'; host.status='idle';
  host.harnessName = 'lazy-failure-verification';
  const registry = new SessionRegistry(); registry.map.set(host.id, host);
  const bus = createBus({clients: new Set()});
  const service = createSqliteWorkItemService({db, bus, generateKey:()=> 'unused', launchRun:()=> {},
    continueRun: input => launchSession({registry, bus, options: {sessionKey:host.id, workItemId:'work', runKind:'primary', role:'default',
      cwd:cwd, prompt:input.prompt, continuitySource:'system', invocationKind:'resume_open_run', harness:host.harnessName}})});
  const deps = {bus, startChildSession:()=> {}, forEachLeaderTaskState() {}, wakeDelivery:createWakeDeliveryStore(db), resumeWorkItemRun: input=>service.resumePrimaryRun(input)};
  registry.setDeps(deps);
  try {
    requestCoalescedWake(host, deps, {immediate:true,idempotencyKey:'failed-open',onDelivered:()=>acknowledged++,opts:{sessionKey:'run',cwd:cwd,prompt:'important child instruction'}});
    for (let i = 0; i < 10; i++) await tick();
    const receipts = db.prepare('SELECT state FROM wake_delivery').all();
    const invocations = db.prepare('SELECT count(*) n FROM run_invocations').get().n;
    console.log('failed-open evidence:', JSON.stringify({status:host.status,error:host.lastError,acknowledged,invocations,receipts}));
    if (mode.endsWith('throw')) assert.equal(host.status,'error');
    assert.equal(invocations,1);
    assert.equal(acknowledged,mode === 'completed' ? 1 : 0,'Only successful provider response evidence acknowledges attention');
    assert.equal(receipts[0].state,mode === 'completed' ? 'delivered' : 'failed');
  } finally {cancelCoalescedWake(host);closePersistDb();}
});
}
