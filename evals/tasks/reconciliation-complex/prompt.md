# Multi-file reconciliation CLI

Repair `src/index.mjs`. Run with Node 22+, no dependencies:

```
node src/index.mjs orders.json payments.json refunds.json rates.json
```

Exactly four positional paths are required (including paths with spaces). Each
UTF-8 JSON file contains an array; stdin is unused. Empty arrays are valid.
Emit exactly one compact JSON object followed by LF, with no stderr on success
(exit 0). Invalid arguments, unreadable files, invalid JSON or any invalid row
invalidate the entire invocation: exit 2, empty stdout, nonempty stderr.

Rows have these required fields (extra fields are ignored):

- Orders: `{id,currency}`. IDs are unique within this file.
- Payments and refunds: `{id,orderId,at,amount,currency}`. IDs are independent
  between payments and refunds. Refunds reference orders, not payment IDs.
- Rates: `{from,to,at,value}`. Rates are direct multipliers only; do not invert
  or chain them.

IDs match `[A-Za-z0-9_-]{1,64}` and currency codes `[A-Z]{3}`. Amounts and rate
values are JSON strings matching `\d{1,24}(\.\d{1,6})?`; no signs, exponent,
whitespace or JSON numbers. Amounts may be zero; rates must be positive.
Timestamps use `YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss±HH:mm`, optionally
with exactly three fractional second digits. Years are 2000–2099, Gregorian
calendar dates must exist, hours 00–23, minutes/seconds 00–59 and offsets range
00:00–14:00 (14 requires minute 00). Leap seconds and local-only dates are invalid.
Compare UTC instants, never textual dates or the host timezone.

Validate all rows before deduplication. Within each event file retain the row
with greatest timestamp for each ID; equal instants choose the later input row.
For a known order choose the matching direct rate with greatest timestamp at or
before the event instant; rate timestamp ties choose the later input row.
Same-currency conversion is always 1, ignoring the rate file for that event.

Process all retained payments first, then retained refunds in ascending UTC
instant order with ASCII ID tie-break. Thus even a refund dated before a payment
can consume that payment. A refund is partial when it consumes only some of the
remaining balance. Compare its exact converted value to the exact remaining
balance; if larger, reject the whole refund (no clamping), leaving the balance
unchanged for later refunds. No intermediate rounding, including this comparison.

Exceptions do not change balances. Precedence per retained event is
`UNKNOWN_ORDER`, then `MISSING_RATE`, then (refund only) `EXCESS_REFUND`.
Zero events still require a known order and, when converting, an applicable rate.
Output every order, including those with zero balance. Sum exact converted
decimals, then round once per final order balance to two decimals, half-up.
Large amounts must retain decimal precision; do not use floating-point money.

Output field order is exactly as shown:

```
{"balances":[{"orderId":"o1","balance":"8.01","currency":"USD"}],"exceptions":[{"eventId":"p2","code":"UNKNOWN_ORDER"}]}
```

Sort balances by ASCII `orderId`. Sort exceptions by ASCII `eventId`, then ASCII
`code`; preserve identical exceptions when IDs occur in both event files.
Balance strings always have two fractional digits, never exponent or minus zero.
Do not modify input files. Your submission consists of `src/**` only.
