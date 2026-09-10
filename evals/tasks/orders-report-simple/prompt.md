# Orders monthly report CLI

Implement `node src/index.mjs` using Node.js 22 built-ins. Read the entire CSV
from stdin and emit the monthly report to stdout. No arguments are accepted.

Input dialect and validation:

- This intentionally small unquoted CSV dialect has exactly the first line
  `id,created_at,amount` in that order, with no BOM or surrounding whitespace.
  Accept LF and CRLF and an optional final newline. Quoting/embedded commas or
  newlines are unsupported. Each data line must contain exactly three fields.
- ID is 1–64 characters from ASCII letters, digits, underscore and hyphen,
  case sensitive. Whitespace is not trimmed. Invalid/blank data lines are skipped.
- Timestamp is a real Gregorian date in years 0001–9999 formatted
  `YYYY-MM-DDTHH:mm:ss[.sss](Z|+HH:mm|-HH:mm)`. Optional milliseconds have exactly
  three digits. Hours 00–23, minutes/seconds 00–59 (no leap seconds), and offset
  hours 00–23/minutes 00–59. Reject impossible dates and timestamps without an
  explicit timezone. The resulting UTC year must also be 0001–9999.
- Amount matches `[+-]?[0-9]+(\.[0-9]{1,2})?` with no spaces or exponent.
  Negative amounts, leading zeroes, and amounts larger than JavaScript safe
  integers are valid. Compute arbitrary-precision integer cents; do not use
  floating-point arithmetic for amounts or totals. `-0.50` is negative 50 cents.
- A malformed row is ignored entirely. For duplicate IDs the **last valid row**
  wins, replacing both amount and timestamp, even across months. An invalid
  later row must not erase an earlier valid row.

Output:

- Use UTC calendar month `YYYY-MM`, sorted ascending, with exactly
  `month,total\n` followed by `YYYY-MM,decimal\n` for each month represented
  among winning orders. Keep zero-total months; print exactly two decimal
  places, a minus only for negative totals, and no plus/negative zero.
- Valid input (even header-only or all-invalid rows) exits 0 with empty stderr.
  Header-only emits exactly `month,total\n`.
- Any argument, empty input, or incorrect/missing header exits 2, with empty
  stdout and nonempty stderr. Other diagnostics have no specified wording.

Example input:

```csv
id,created_at,amount
a,2025-01-31T23:00:00-02:00,1.10
b,2025-01-01T00:00:00Z,2.20
a,2025-02-01T00:00:00Z,3.33
bad,nope,4
```

Output is `month,total\n2025-01,2.20\n2025-02,3.33\n`.
Run `node src/index.mjs < orders.csv`. Parsing, duplicate winners, exact UTC
monthly totals, and exit/output discipline are separate mandatory criteria.
