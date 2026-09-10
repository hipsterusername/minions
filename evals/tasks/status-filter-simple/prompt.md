# Status list API

Extend the named export `list(records, options = {})` in `src/index.mjs`.
This is a dependency-free Node.js 22 ESM module API, called in a separate process.
Keep the existing pagination behavior while adding a status filter.

- Records are JSON objects with `id` and status `open`, `closed`, or `pending`;
  they may have additional fields and duplicate IDs. Preserve every field,
  duplicate, and original order. Never mutate the input or its records.
- Options is an object when supplied. `status` omitted or explicitly `undefined`
  means no filter. Only exact strings `open`, `closed`, `pending` are valid
  supplied filters; null, empty strings, numbers and all other values throw
  `RangeError`. An empty result still requires validation.
- `page` defaults to 0 and `pageSize` to 20 (also when explicitly undefined).
  Page must be a nonnegative safe integer and pageSize a positive safe integer;
  otherwise throw `RangeError`. Strings, null, fractions, NaN, infinity and
  integers outside the safe range are invalid.
- Filter first, then take zero-based indices from `page * pageSize` inclusive
  to `(page + 1) * pageSize` exclusive. Return a new array. Empty input and pages
  starting at/beyond the filtered length return `[]`. No deduplication occurs.
- Unknown option keys are ignored. Non-object options and malformed records
  are outside the input contract. No deep copy is required.

Example: for `[ {id:'a',status:'open'}, {id:'b',status:'closed'},
{id:'c',status:'open'} ]`, `{status:'open',page:1,pageSize:1}` returns
`[{id:'c',status:'open'}]`. An omitted filter preserves the legacy paginated list.

Run public examples with `node --input-type=module` and import
`{list} from './src/index.mjs'`. Supported values/validation, unchanged baseline,
and filter-before-pagination are separate mandatory criteria.
