import { readFileSync } from 'node:fs';

function timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min, s, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1] || +h > 23 || +min > 59 || +s > 59) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
  return date.toISOString().slice(0, 7);
}
function cents(value) {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -magnitude : magnitude;
}
function format(value) {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
const lines = readFileSync(0, 'utf8').split(/\r?\n/);
if (process.argv.length !== 2 || lines.shift() !== 'id,created_at,amount') {
  process.stderr.write('usage: node src/index.mjs < orders.csv (id,created_at,amount header required)\n');
  process.exitCode = 2;
} else {
  const winners = new Map();
  for (const line of lines) {
    const fields = line.split(',');
    if (fields.length !== 3) continue;
    const [id, at, amount] = fields;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^[+-]?\d+(?:\.\d{1,2})?$/.test(amount)) continue;
    const month = timestamp(at);
    if (month !== null) winners.set(id, { month, cents: cents(amount) });
  }
  const totals = new Map();
  for (const row of winners.values()) totals.set(row.month, (totals.get(row.month) ?? 0n) + row.cents);
  process.stdout.write('month,total\n' + [...totals.keys()].sort().map(month => `${month},${format(totals.get(month))}\n`).join(''));
}
