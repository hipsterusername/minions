import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const request = JSON.parse(readFileSync(0, 'utf8'));
const { directory, now, leaseMs, retryMs, crashAt } = request;
const file = join(directory, 'state.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
// The queue and effect journal share one atomic snapshot. A process crash leaves
// either the old or new transaction; a leftover .next file is never authoritative.
function commit() {
  const next = `${file}.next`;
  writeFileSync(next, JSON.stringify(state) + '\n');
  const fd = openSync(next, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(next, file);
  const dir = openSync(directory, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function checkpoint(point) {
  if (crashAt === point) process.kill(process.pid, 'SIGKILL');
}
for (const job of state.jobs) {
  if (job.status === 'done') continue;
  if (job.status === 'claimed' && job.leaseUntil > now) continue;
  if (job.status === 'ready' && job.availableAt > now) continue;
  job.status = 'claimed';
  job.leaseUntil = now + leaseMs;
  job.attempts += 1;
  commit();
  checkpoint('after-claim');
  if (job.attempts <= job.failures) {
    job.status = 'ready';
    job.leaseUntil = null;
    job.availableAt = now + retryMs;
    commit();
    continue;
  }
  checkpoint('before-effect');
  // BUG: a committed effect may already exist after a crash.
  {
    state.effects.push({ jobId: job.id, value: job.value });
    commit();
  }
  checkpoint('after-effect');
  job.status = 'done';
  job.leaseUntil = null;
  commit();
}
process.stdout.write(JSON.stringify({ pid: process.pid }) + '\n');
