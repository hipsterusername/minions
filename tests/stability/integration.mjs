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

test('50,000 duplicate wakes and 5,000 distinct requests stay bounded without dispatch while busy', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'minions-wake-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const host = new SessionHost('pressure', cwd); host.status = 'running';
  let calls = 0;
  const deps = { startChildSession: () => { calls++; }, bus: createBus({clients: new Set()}), forEachLeaderTaskState() {} };
  const request = { idempotencyKey: 'same', opts: {sessionKey: host.id, cwd: cwd, prompt: '漢😀'.repeat(1000)} };
  try {
    for (let i = 0; i < 50000; i++) requestCoalescedWake(host, deps, request);
    assert.equal(getWakeQueueStats(host).count, 1);
    for (let i = 0; i < 5000; i++) requestCoalescedWake(host, deps, {...request, idempotencyKey: String(i)});
    assert.ok(getWakeQueueStats(host).count <= 32);
    assert.ok(getWakeQueueStats(host).bytes <= 256 * 1024);
    assert.equal(calls, 0);
    console.log('wake pressure:', JSON.stringify(getWakeQueueStats(host)));
  } finally { cancelCoalescedWake(host); }
  assert.equal(getWakeQueueStats(host).count, 0);
});

test('canonical wake must not acknowledge a provider start failure', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'minions-wake-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const db = openPersistDb(':memory:'); ensureWorkItemSchema(db);
  createWorkItem(db, {id:'work', projectId:'project', projectPath:cwd, title:'wake', changeMode:'live', at:1});
  startWorkItemIteration(db, {workItemId:'work', runKey:'run', idempotencyKey:'start', expectedLifecycleRevision:0, expectedCurrentRunKey:null, at:2});
  db.prepare("UPDATE work_items SET runtime_state='waiting',wait_kind='timer' WHERE id='work'").run();
  const host = new SessionHost('run', cwd); host.workItemId='work'; host.runKind='primary'; host.role='leader'; host.status='idle';
  host.harnessName = 'missing-provider-verification';
  const registry = new SessionRegistry(); registry.map.set(host.id, host);
  const bus = createBus({clients: new Set()});
  const service = createSqliteWorkItemService({db, bus, generateKey:()=> 'unused', launchRun:()=> {},
    continueRun: input => launchSession({registry, bus, options: {sessionKey:host.id, workItemId:'work', runKind:'primary', role:'leader',
      cwd:cwd, prompt:input.prompt, continuitySource:'system', invocationKind:'resume_open_run', harness:host.harnessName}})});
  const deps = {bus, startChildSession:()=> {}, forEachLeaderTaskState() {}, wakeDelivery:createWakeDeliveryStore(db), resumeWorkItemRun: input=>service.resumePrimaryRun(input)};
  registry.setDeps(deps);
  let acknowledged = 0;
  try {
    requestCoalescedWake(host, deps, {immediate:true,idempotencyKey:'failed-open',onDelivered:()=>acknowledged++,opts:{sessionKey:'run',cwd:cwd,prompt:'important child instruction'}});
    await tick(); await tick();
    const receipts = db.prepare('SELECT state FROM wake_delivery').all();
    const invocations = db.prepare('SELECT count(*) n FROM run_invocations').get().n;
    console.log('failed-open evidence:', JSON.stringify({status:host.status,error:host.lastError,acknowledged,invocations,receipts}));
    assert.equal(host.status,'error'); assert.equal(invocations,0);
    assert.equal(acknowledged,0,'A wake was acknowledged even though no provider invocation was opened');
  } finally {cancelCoalescedWake(host);closePersistDb();}
});
