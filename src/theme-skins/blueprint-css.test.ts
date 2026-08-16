import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./blueprint.css", import.meta.url)),
  "utf8",
);

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector ${selector} not found in blueprint.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("Blueprint typography", () => {
  it("uses restrained mixed-case labels", () => {
    const tokens = ruleBody(':root[data-theme="blueprint"]');
    expect(tokens).toContain("--label-transform: none");
    expect(tokens).toContain("--letter-spacing-label: 0.035em");
  });

  it("keeps controls technical without forcing their copy to uppercase", () => {
    const buttons = ruleBody(':root[data-theme="blueprint"] button');
    expect(buttons).toContain("text-transform: none");
    expect(buttons).toContain("letter-spacing: var(--letter-spacing-label)");
  });

  it("uses compact mixed-case display headings", () => {
    const headings = ruleBody(`:root[data-theme="blueprint"] h1,
:root[data-theme="blueprint"] h2,
:root[data-theme="blueprint"] h3`);
    expect(headings).toContain("font-family: var(--font-display)");
    expect(headings).toContain("text-transform: none");
    expect(headings).toContain("letter-spacing: -0.015em");
  });
});

describe("Blueprint canvas background", () => {
  it("enables the grid only for the Blueprint theme", () => {
    expect(css).toMatch(
      /:root\[data-theme="blueprint"\]\s*\{[^}]*--blueprint-grid-display: block/s,
    );
  });

  it("keeps the curved depth treatment scoped to Blueprint", () => {
    const curveLayer = ruleBody(
      ':root[data-theme="blueprint"] .blueprint-curve-grid',
    );

    expect(curveLayer).toContain("mix-blend-mode: screen");
    expect(css).not.toMatch(/(?:^|\n)\.blueprint-curve-grid\s*\{/);
  });
});
