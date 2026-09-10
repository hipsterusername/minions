# Project archive feature

Complete the existing small Node HTTP app in `src/`. Use Node >=22.13 with
`node:sqlite`; no service or credentials are needed. Start with
`DB_PATH=/absolute/path/projects.sqlite PORT=0 node src/server.mjs`. Bind loopback;
print one JSON line `{ "port": <bound port> }` when ready. PORT may also be a
specific port. Serve actual HTML at `/` and client JavaScript at `/app.js`.

The existing on-disk SQLite `projects` table has `id TEXT PRIMARY KEY`, and
`name`, `owner`, `description` (all non-null TEXT). Add nullable TEXT `archivedAt`
in place. Existing rows start with null; preserve all rows/fields, including empty
strings and Unicode. Migration must be safe on every restart and must not clear
archive state. A fresh database creates an empty table with the same schema.
All mutations must commit before returning success and survive abrupt process
termination. Use the provided DB_PATH, not an alternate/in-memory store.

JSON API (project objects contain exactly id, name, owner, description, archivedAt):

- `GET /api/projects`: active only, ordered by id using SQLite BINARY order.
  `?archived=false` is equivalent; `?archived=true` returns archived only.
  Any other archived value returns 400 `{ "error": "INVALID_FILTER" }`.
- `GET /api/projects/:id`: readable in either state.
- `POST /api/projects/:id/archive`: 200 with project; set archivedAt to a valid
  UTC ISO timestamp on first archive only. Repeated archive returns unchanged
  timestamp and fields.
- `POST /api/projects/:id/restore`: 200 with project; clear only archivedAt.
  Restoring an active project is also a successful unchanged operation.
- `PATCH /api/projects/:id`: accept a JSON object with any subset of name, owner,
  description, all strings (empty allowed). Preserve omitted fields. Unknown
  fields, non-object input, non-string values or malformed JSON return 400
  `{ "error": "INVALID_PATCH" }` without changing data. Archived projects always
  reject PATCH with 409 `{ "error": "ARCHIVED" }`, even for an empty patch.
- Unknown project IDs return 404 `{ "error": "NOT_FOUND" }` for every operation.
  Unsupported methods on known project routes return 405
  `{ "error": "METHOD_NOT_ALLOWED" }`; unknown routes return 404 NOT_FOUND.
  IDs are URL encoded path segments. Responses use application/json.

Browser UI: a select with accessible name `Project filter` and options `Active`
(value false, default) and `Archived` (value true); list items identify projects
using `data-project-id` and display project names as text, including names with
HTML-like characters. Active rows have an `Archive` button, archived rows have
`Restore`. Clicking acts through the API and refreshes the list without a manual
page reload. Changing the filter refreshes the list. A reload preserves database
state (filter may reset to Active). No network/CDN assets are needed.

`example.json` is public legacy data for exploration; production startup must not
reseed an existing database. You may edit src files and add migrations. Browser
verification uses Playwright 1.62.1 and Chromium installed before execution.
