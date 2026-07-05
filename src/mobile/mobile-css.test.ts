import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// jsdom has no layout engine, so the overflow bug these rules fix cannot be
// asserted via getBoundingClientRect. This is a source-contract regression
// test: it pins the declarations that keep the activity/approvals cards from
// stretching past the viewport.
//
// Bug: the card grids declared `display: grid` with no explicit columns, so
// the implicit track sized to `auto` (== max-content). When a card's
// `.mob-card-activity` line (white-space: nowrap) updated to a long unbroken
// string, its max-content width inflated the track and the `width: 100%` card
// overflowed the screen horizontally. Constraining every grid container in the
// chain to `minmax(0, 1fr)` bounds the track to the viewport width.

const css = readFileSync(
  fileURLToPath(new URL("./mobile.css", import.meta.url)),
  "utf8",
);

/** Extract the body of a single CSS rule by its selector. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector ${selector} not found in mobile.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("mobile.css overflow guards", () => {
  it.each([
    ".mob-activity-section",
    ".mob-session-list",
    ".mob-approval-list",
    ".mob-project-list",
  ])("constrains the %s grid track to minmax(0, 1fr)", (selector) => {
    const body = ruleBody(selector);
    expect(body).toContain("display: grid");
    expect(body.replace(/\s+/g, " ")).toContain(
      "grid-template-columns: minmax(0, 1fr)",
    );
  });

  it.each([".mob-session-card", ".mob-approval-card", ".mob-project-card"])(
    "lets the %s shrink inside its track via min-width: 0",
    (selector) => {
      expect(ruleBody(selector)).toContain("min-width: 0");
    },
  );

  it("keeps the activity line able to ellipsize instead of forcing width", () => {
    const body = ruleBody(".mob-card-activity");
    expect(body).toContain("min-width: 0");
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("text-overflow: ellipsis");
  });

  it("keeps composer textarea text visible on mobile WebKit", () => {
    const body = ruleBody(".mob-composer textarea");
    expect(body).toContain("min-width: 0");
    expect(body).toContain("-webkit-appearance: none");
    expect(body).toContain("-webkit-text-fill-color: var(--text-primary)");
    expect(body).toContain("caret-color: var(--accent)");
    expect(body).toContain("font-size: 16px");
  });
});
