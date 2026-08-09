/**
 * Ambient type augmentation for the vitest test environment.
 *
 * `tests/setup-dom.ts` performs the runtime side-effect import of
 * `@testing-library/jest-dom/vitest` so the matchers are wired into
 * `expect(...)` at test time. That side-effect file is loaded by vitest,
 * not by `tsc` — so the matcher types (`toBeInTheDocument`, etc.) are
 * invisible to the type checker without this declaration.
 *
 * Importing the same module here, in a `.d.ts` file under `src/`, makes
 * the global `Assertion` augmentation visible to `tsc -b` without
 * pulling any runtime code into the bundle.
 */

import "@testing-library/jest-dom/vitest";
