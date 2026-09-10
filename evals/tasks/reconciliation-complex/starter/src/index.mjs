import { readFileSync } from 'node:fs';
// Starting implementation: only same-currency payments are handled.
try {
  if (process.argv.length !== 6) throw new Error('Expected four files');
  const [orders, payments, refunds, rates] = process.argv.slice(2).map(p => JSON.parse(readFileSync(p, 'utf8')));
  if (![orders,payments,refunds,rates].every(Array.isArray)) throw new Error('Expected arrays');
  const balances = orders.map(order => ({orderId:order.id,
    balance:payments.filter(p => p.orderId === order.id && p.currency === order.currency)
      .reduce((sum,p) => sum + Number(p.amount), 0).toFixed(2), currency:order.currency}));
  process.stdout.write(JSON.stringify({balances,exceptions:[]}) + '\n');
} catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 2; }
