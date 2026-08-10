import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// jsdom does not calculate layout, so these source-contract tests pin the
// declarations that keep the settings popover inside the viewport and make
// each independently scrollable region shrink within the dialog grid.
const css = readFileSync(
  fileURLToPath(new URL("./settings-menu.css", import.meta.url)),
  "utf8",
);

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector ${selector} not found in settings-menu.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("settings menu layout guards", () => {
  it("pins the dialog to the viewport and bounds it by the dynamic viewport", () => {
    const body = ruleBody(".settings-dialog");
    expect(body).toContain("position: fixed");
    expect(body).toContain("100dvh");
    expect(body).toContain("max-height:");
  });

  it.each([".settings-sidebar", ".settings-content"])(
    "lets %s shrink and scroll inside the dialog grid",
    (selector) => {
      const body = ruleBody(selector);
      expect(body).toContain("min-height: 0");
      expect(body).toContain("overflow-y: auto");
    },
  );

  it("positions picker menus against the viewport instead of a clipping card", () => {
    const body = ruleBody(".settings-icon-picker__menu");
    expect(body).toContain("position: fixed");
    expect(body).toContain("top: 0");
    expect(body).toContain("left: 0");
  });

  it("stacks role cards before their full model menus become cramped", () => {
    const breakpoint = css.slice(css.indexOf("@media (max-width: 860px)"));
    expect(breakpoint).toContain(".settings-agent-list");
    expect(breakpoint).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("lets each role configuration shrink inside the two-column card layout", () => {
    const list = ruleBody(".settings-agent-list");
    expect(list).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");

    const card = ruleBody(".settings-agent");
    expect(card).toContain("min-width: 0");

    const configuration = ruleBody(".settings-agent__configuration");
    expect(configuration).toContain("min-width: 0");
  });
});
