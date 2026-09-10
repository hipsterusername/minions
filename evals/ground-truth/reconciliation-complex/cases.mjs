// Controller-only cases. No participant imports. Expected strings below are
// hand-calculated; seeded expectations use integer ledger units before rendering.
const at = '2025-01-01T00:00:00Z';
const order = (id='o', currency='USD') => ({id,currency});
const event = (id,amount,extra={}) => ({id,orderId:'o',at,amount,currency:'USD',...extra});
const rate = (value,extra={}) => ({from:'EUR',to:'USD',at,value,...extra});
const balance = (value,id='o',currency='USD') => ({orderId:id,balance:value,currency});
const exception = (eventId,code) => ({eventId,code});
const empty = () => ({orders:[order()],payments:[],refunds:[],rates:[]});
export function cases(seed) {
  const tests = [];
  function add(criterion,name,input,balances,exceptions=[]) {
    tests.push({criterion,name,input,expected:JSON.stringify({balances,exceptions})+'\n',code:0});
  }
  add('joins','zero-orders-sorted', {...empty(),orders:[order('z'),order('A'),order('a')]}, [balance('0.00','A'),balance('0.00','a'),balance('0.00','z')]);
  add('joins','precedence-and-duplicate-exceptions', {...empty(),
    payments:[event('x','0',{orderId:'absent',currency:'EUR'}),event('m','0',{currency:'GBP'})],
    refunds:[event('x','1',{orderId:'absent'}),event('a','99',{currency:'JPY'})]},
    [balance('0.00')],[exception('a','MISSING_RATE'),exception('m','MISSING_RATE'),exception('x','UNKNOWN_ORDER'),exception('x','UNKNOWN_ORDER')]);
  add('deduplication','utc-winner-tie-and-separate-namespaces',{...empty(), payments:[
    event('p','3',{at:'2024-12-31T23:30:00-02:00'}),
    event('p','99',{at:'2025-01-01T01:00:00Z'}),
    event('p','4',{at:'2025-01-01T02:30:00+01:00'}),
  ],refunds:[event('p','0.5'),event('p','2')]},[balance('2.00')]);
  add('deduplication','payment-tie-isolated',{...empty(),payments:[event('p','1'),event('p','3')]},[balance('3.00')]);
  add('deduplication','refund-tie-isolated',{...empty(),payments:[event('p','5')],refunds:[event('r','1'),event('r','3')]},[balance('2.00')]);
  add('rates','utc-boundary-direct-tie',{...empty(), payments:[event('p','2',{currency:'EUR',at:'2025-01-01T00:30:00-01:00'})], rates:[
    rate('2',{at:'2024-12-31T23:00:00-02:00'}),
    rate('3',{at:'2025-01-01T02:30:00+01:00'}),
    rate('4',{at:'2025-01-01T01:30:00Z'}),
    rate('99',{at:'2025-01-01T01:30:00.001Z'}),
    rate('80',{from:'USD',to:'EUR'}),rate('7',{to:'GBP'}),
  ]},[balance('8.00')]);
  add('rates','no-inverse-chain-or-future',{...empty(),payments:[event('p','1',{currency:'EUR'})], rates:[
    rate('3',{from:'USD',to:'EUR'}),rate('2',{to:'GBP'}),rate('2',{from:'GBP'}),rate('9',{at:'2025-01-01T00:00:00.001Z'})]},
    [balance('0.00')],[exception('p','MISSING_RATE')]);
  add('rates','identity-ignores-rate',{...empty(), payments:[event('p','2')],rates:[rate('99',{from:'USD'})]},[balance('2.00')]);
  add('refunds','partial-order-and-rejected-refund-no-clamp',{...empty(),payments:[event('p','10')],refunds:[
    event('c','2',{at:'2025-01-03T00:00:00Z'}),event('b','5',{at:'2025-01-02T00:00:00Z'}),
    event('a','6',{at:'2025-01-02T00:00:00Z'}),event('z','1',{at:'2024-12-01T00:00:00Z'}),
  ]},[balance('1.00')],[exception('b','EXCESS_REFUND')]);
  add('refunds','unrounded-limit',{...empty(),payments:[event('p','0.004')],refunds:[event('a','0.005'),event('b','0.004')]},
    [balance('0.00')],[exception('a','EXCESS_REFUND')]);
  add('refunds','convert-refunds-at-own-date',{...empty(),payments:[event('p','10')],refunds:[event('r','2',{currency:'EUR',at:'2025-01-02T00:00:00Z'})],rates:[rate('1'),rate('3',{at:'2025-01-02T00:00:00Z'})]},[balance('4.00')]);
  add('rounding','aggregate-before-half-up',{...empty(),payments:[event('a','0.004'),event('b','0.004'),event('c','1.005')],refunds:[event('r','1')]},[balance('0.01')]);
  add('rounding','exact-half-up-large-decimal',{...empty(),payments:[event('a','900719925474099312345.005')]},[balance('900719925474099312345.01')]);
  add('rounding','six-digit-product',{...empty(),payments:[event('a','1.000001',{currency:'EUR'}),event('b','0.004999')],rates:[rate('1.000001')]},[balance('1.01')]);
  add('io','empty-files',{orders:[],payments:[],refunds:[],rates:[]},[]);
  add('io','leap-day-offset-and-ignored-fields',{...empty(),payments:[{...event('p','0001.20',{at:'2000-02-29T14:00:00+14:00'}),note:'ignored'}]},[balance('1.20')]);

  // Generated semantic ledger: milli-unit payments, six-decimal multipliers.
  // Expected totals never parse candidate output or the rendered input decimals.
  let state = [...String(seed)].reduce((n,c) => (Math.imul(n,31)+c.charCodeAt(0))>>>0, 19);
  const random = n => { state = (Math.imul(state,1664525)+1013904223)>>>0; return state % n; };
  const input = {orders:[],payments:[],refunds:[],rates:[]}, expected = [], errors = [];
  for (let i=0;i<24;i++) {
    const id = `o_${String(i).padStart(2,'0')}`, currency = `X${String.fromCharCode(65+Math.floor(i/26))}${String.fromCharCode(65+i%26)}`;
    const paid = 10000 + random(90000), partial = random(paid), multiplier = 100000 + random(1900000);
    const dec = (n,places) => `${Math.floor(n/10**places)}.${String(n%10**places).padStart(places,'0')}`;
    input.orders.unshift(order(id));
    input.rates.push(rate(dec(multiplier,6),{from:currency}),rate('99',{from:currency,at:'2025-01-02T00:00:00Z'}));
    input.payments.push(event(`p_${i}`,'999999',{orderId:id,currency,at:'2024-12-31T23:59:59Z'}),event(`p_${i}`,dec(paid,3),{orderId:id,currency}));
    input.refunds.push(event(`r_${i}`,dec(partial,3),{orderId:id,currency}),event(`s_${i}`,dec(paid+1,3),{orderId:id,currency}));
    // units are billionths, and all semantic operands remain exact safe integers.
    const units = BigInt(paid-partial)*BigInt(multiplier);
    const cents = units / 10000000n + (units % 10000000n >= 5000000n ? 1n : 0n);
    expected.push(balance(`${cents/100n}.${String(cents%100n).padStart(2,'0')}`,id));
    errors.push(exception(`s_${i}`,'EXCESS_REFUND'));
  }
  errors.sort((a,b) => a.eventId < b.eventId ? -1 : 1);
  add('all','seeded-independent-ledger',input,expected,errors);

  function invalid(name,input,extra={}) { tests.push({criterion:'io',name,input,expected:'',code:2,...extra}); }
  invalid('missing-argument',empty(),{omitArgument:true});
  invalid('extra-argument',empty(),{extraArgument:true});
  invalid('unreadable-file',empty(),{missingFile:true});
  invalid('invalid-json',empty(),{raw:{payments:'{'}});
  invalid('not-array',empty(),{raw:{orders:'{}'}});
  invalid('duplicate-orders',{...empty(),orders:[order(),order()]});
  for (const amount of ['-1','+1','1e2','1.0000001',' 1','1.','.1','',1,null,'1234567890123456789012345'])
    invalid(`invalid-amount-${JSON.stringify(amount)}`,{...empty(),payments:[event('p',amount)]});
  for (const stamp of ['2025-02-29T00:00:00Z','2024-04-31T00:00:00Z','2025-01-01','2025-01-01T00:00:00','2025-01-01T24:00:00Z','2025-01-01T00:00:60Z','2025-01-01T00:00:00+14:01','2025-01-01T00:00:00+15:00','2025-01-01T00:00:00+01:60','2025-01-01T00:00:00.1Z','1999-12-31T23:00:00Z','2100-01-01T00:00:00Z'])
    invalid(`invalid-date-${stamp}`,{...empty(),payments:[event('p','1',{at:stamp})]});
  invalid('validate-losing-duplicate',{...empty(),payments:[event('p','bad'),event('p','1',{at:'2025-01-02T00:00:00Z'})]});
  for (const row of [null,[],{},order('', 'USD'),order('has space'),order('o','usd')]) invalid('invalid-order-row',{...empty(),orders:[row]});
  invalid('invalid-refund',{...empty(),refunds:[null]});
  invalid('invalid-rate',{...empty(),rates:[rate('0')]});
  invalid('invalid-rate-date',{...empty(),rates:[rate('1',{at:'invalid'})]});
  return tests;
}
