import { readFileSync } from 'node:fs';
const SCALE = 1000000n;
const fail = () => { throw new Error('Invalid reconciliation input'); };
const ascii = (a,b) => a < b ? -1 : a > b ? 1 : 0;
function text(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) fail(); return value; }
const id = value => text(value, /^[A-Za-z0-9_-]{1,64}$/);
const currency = value => text(value, /^[A-Z]{3}$/);
function decimal(value) {
  text(value, /^\d{1,24}(\.\d{1,6})?$/);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
function instant(value) {
  text(value, /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/);
  const year = +value.slice(0,4), month = +value.slice(5,7), day = +value.slice(8,10);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate() ||
      +value.slice(11,13) > 23 || +value.slice(14,16) > 59 || +value.slice(17,19) > 59) fail();
  if (!value.endsWith('Z')) {
    const hours = +value.slice(-5,-3), minutes = +value.slice(-2);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) fail();
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail();
  return result;
}
function event(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
  return {id:id(row.id),orderId:id(row.orderId),time:instant(row.at),amount:decimal(row.amount),currency:currency(row.currency)};
}
function latest(rows) {
  const winners = new Map();
  for (const row of rows) if (!winners.has(row.id) || row.time >= winners.get(row.id).time) winners.set(row.id,row);
  return [...winners.values()];
}
function reconcile(orders,payments,refunds,rates) {
  const balances = new Map(), exceptions = [];
  for (const order of orders) {
    if (!order || typeof order !== 'object' || Array.isArray(order)) fail();
    id(order.id); currency(order.currency);
    if (balances.has(order.id)) fail();
    balances.set(order.id,{currency:order.currency,total:0n});
  }
  payments = payments.map(event); refunds = refunds.map(event);
  rates = rates.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
    const value = decimal(row.value); if (value === 0n) fail();
    return {from:currency(row.from),to:currency(row.to),time:instant(row.at),value};
  });
  function apply(row, refund) {
    const order = balances.get(row.orderId);
    let code;
    if (!order) code = 'UNKNOWN_ORDER';
    else {
      let rate;
      if (row.currency === order.currency) rate = SCALE;
      else {
        let selected;
        for (const r of rates) if (r.from === row.currency && r.to === order.currency && r.time <= row.time && (!selected || r.time >= selected.time)) selected = r;
        rate = selected?.value;
      }
      if (rate === undefined) code = 'MISSING_RATE';
      else {
        const converted = row.amount * rate;
        if (refund && converted > order.total) code = 'EXCESS_REFUND';
        else order.total += refund ? -converted : converted;
      }
    }
    if (code) exceptions.push({eventId:row.id,code});
  }
  for (const row of latest(payments)) apply(row,false);
  for (const row of latest(refunds).sort((a,b) => a.time - b.time || ascii(a.id,b.id))) apply(row,true);
  const output = [...balances].sort(([a],[b]) => ascii(a,b)).map(([orderId,order]) => {
    const cents = (order.total + 5000000000n) / 10000000000n;
    return {orderId,balance:`${cents / 100n}.${String(cents % 100n).padStart(2,'0')}`,currency:order.currency};
  });
  exceptions.sort((a,b) => ascii(a.eventId,b.eventId) || ascii(a.code,b.code));
  return {balances:output,exceptions};
}
try {
  if (process.argv.length !== 6) fail();
  const arrays = process.argv.slice(2).map(path => JSON.parse(readFileSync(path,'utf8')));
  if (!arrays.every(Array.isArray)) fail();
  process.stdout.write(JSON.stringify(reconcile(...arrays)) + '\n');
} catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 2; }
