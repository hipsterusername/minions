import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./context-actions-settings.css", import.meta.url)),
  "utf8",
);

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector ${selector} not found`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("context action editor layout guards", () => {
  it("bounds the editor and lets each nested layout region shrink", () => {
    expect(ruleBody(".context-actions")).toContain("height: clamp(");

    for (const selector of [
      ".context-actions__master",
      ".context-actions__detail",
      ".context-actions__sections",
    ]) {
      expect(ruleBody(selector)).toContain("min-height: 0");
    }
  });

  it.each([".context-actions__list", ".context-actions__sections", ".context-actions__skills"])(
    "contains scrolling within %s",
    (selector) => {
      const body = ruleBody(selector);
      expect(body).toContain("min-height: 0");
      expect(body).toContain("overflow-y: auto");
      expect(body).toContain("overscroll-behavior: contain");
    },
  );

  it("renders action search as a placeholder-only normalized input", () => {
    const input = ruleBody(".context-actions__search-input");
    expect(input).toContain("width: 100%");
    expect(input).toContain("box-sizing: border-box");
    expect(input).toContain("appearance: none");
    expect(input).toContain("background: transparent");
    expect(input).toContain("border: 0");
  });

  it("renders the Skills section as an explicit containing panel", () => {
    const sections = ruleBody(".context-actions__sections");
    expect(sections).toContain("grid-auto-rows: max-content");
    expect(sections).toContain("align-content: start");

    const section = ruleBody(".context-actions__skills-section");
    expect(section).toContain("display: grid");
    expect(section).toContain("width: 100%");
    expect(section).toContain("min-height: max-content");
    expect(section).toContain("box-sizing: border-box");
    expect(section).toContain("overflow: hidden");
    expect(section).toContain("border: 1px solid var(--border-default)");

    const summary = ruleBody(".context-actions__skills-summary");
    expect(summary).toContain("grid-template-columns: minmax(0, 1fr) auto");
  });

  it("matches the Skills action sizing to the Apply button", () => {
    const toggle = ruleBody(".context-actions__skills-toggle");
    const footerButton = ruleBody(".context-actions__footer button");

    for (const declaration of [
      "padding: 7px 10px",
      "font: 600 10px/1.2 var(--font-sans)",
      "border-radius: 5px",
    ]) {
      expect(toggle).toContain(declaration);
      expect(footerButton).toContain(declaration);
    }

    const primary = ruleBody(".context-actions__apply");
    expect(primary).toContain("color: var(--text-on-accent)");
    expect(primary).toContain("background: var(--accent)");
    expect(primary).toContain("border-color: var(--accent)");
  });

  it("keeps the open skill picker visible and contains both preview and option overflow", () => {
    const openSection = ruleBody('.context-actions__skills-section[data-open="true"]');
    expect(openSection).toContain("position: sticky");

    const preview = ruleBody(".context-actions__selected-skills");
    expect(preview).toContain("overflow-x: auto");

    const picker = ruleBody(".context-actions__skill-picker");
    expect(picker).toContain("max-height: clamp(");

    const skills = ruleBody(".context-actions__skills");
    expect(skills).toContain("overflow-y: auto");
  });
});
