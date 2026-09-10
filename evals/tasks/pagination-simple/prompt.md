# Pagination repair

Repair the named export `paginate(items, page, pageSize)` in `src/index.mjs`.
This is a dependency-free Node.js 22 ESM library. Grading imports it in a separate
Node process. No command-line wrapper is required.

- Pages are zero based. `page` must be a nonnegative **safe integer** and
  `pageSize` a positive safe integer (`Number.isSafeInteger`); otherwise throw
  `RangeError`, even for empty input. Numeric strings, null, omitted arguments,
  fractions, NaN and infinities are invalid. Validate both arguments.
- Input is an array of JSON-compatible values. Return a new array containing
  indices `page * pageSize <= index < (page + 1) * pageSize`, in input order.
  Duplicates are retained. Do not mutate the input or its elements.
- Empty input and pages starting at or beyond the length return `[]`.
  An exact multiple has no extra final page; the preceding full page is intact.
- No item-type validation or deep copying is required.

Example: `paginate(['a','b','c','d'], 1, 2)` returns `['c','d']`;
page 2 returns `[]`. Run a public check with:

```sh
node --input-type=module -e "import {paginate} from './src/index.mjs'; console.log(paginate(['a','b','c','d'],1,2))"
```

Acceptance: validation, page boundaries, and order/input preservation are separate
mandatory criteria. Use only Node built-ins; no dependency installation is needed.
