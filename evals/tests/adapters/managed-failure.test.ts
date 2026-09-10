import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ManagedMinionsAdapter } from '../../src/adapters/managed-minions.js';
import type { AdapterConfig, ParticipantRunSpec } from '../../schemas/index.js';

it('retains startup failure through inspect, replay, collection and controller recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-startup-failure-'));
  const config: AdapterConfig = { schemaVersion: 1, adapterId: 'minion-single', settings: { stateRoot: root }, requiredCapabilities: [] };
  const run: ParticipantRunSpec = { schemaVersion: 1, runId: 'failed', idempotencyKey: 'failed', taskId: 'fixture', prompt: 'fixture', workspace: { id: 'fixture', mountPath: root }, limits: { maxTotalTokens: 100, executionTimeoutMs: 1000, preparationTimeoutMs: 1000, gradingTimeoutMs: 1000 }, configuration: { execution: { kind: 'invalid' } }, visibleAssets: [] };
  try {
    const adapter = new ManagedMinionsAdapter(config);
    const handle = await adapter.start(run);
    const saved = JSON.parse(await readFile(join(root, 'instances/failed/startup-error.json'), 'utf8'));
    expect((await adapter.inspect(handle)).terminalOutcome).toBe('infra_error');
    const events = [];
    for await (const event of adapter.observe(handle)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.message).toBe(saved.message);
    const replay = [];
    for await (const event of adapter.observe(handle, 0)) replay.push(event);
    expect(replay).toEqual([]);
    const collected = await adapter.collect(handle);
    expect(collected.usageCoverage).toBe('unavailable');
    expect(collected.provenance.startupError).toBe(saved.message);
    const recovered = new ManagedMinionsAdapter(config);
    expect(await recovered.start(run)).toEqual(handle);
    expect(await recovered.collect(handle)).toEqual(collected);
    expect((await recovered.stop(handle, 'controller_shutdown')).accepted).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
