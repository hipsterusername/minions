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

describe("mobile.css activity redesign surfaces", () => {
  it("lays the summary strip out as three equal, viewport-bounded columns", () => {
    const body = ruleBody(".mob-activity-summary").replace(/\s+/g, " ");
    expect(body).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
  });

  it("accents the attention summary count with the warning token", () => {
    expect(ruleBody(".mob-summary-item--attention strong")).toContain("var(--status-warning)");
  });

  it("makes the summary counts touchable and visibly selected", () => {
    expect(ruleBody(".mob-summary-item")).toContain("touch-action: manipulation");
    expect(ruleBody(".mob-summary-item--active")).toContain("var(--accent)");
  });

  it("gives the visibility filters a touch-sized active tab", () => {
    expect(ruleBody(".mob-filter")).toContain("min-height: 40px");
    expect(ruleBody(".mob-filter--active")).toContain("var(--bg-surface)");
  });

  it("colours the triage rows by attention kind", () => {
    expect(ruleBody(".mob-triage-row--error")).toContain("var(--status-error)");
    expect(ruleBody(".mob-triage-row--waiting")).toContain("var(--status-warning)");
    expect(ruleBody(".mob-triage-row--changes")).toContain("var(--status-success)");
  });

  it("keeps the triage row shrinkable and its title able to wrap", () => {
    expect(ruleBody(".mob-triage-row")).toContain("min-width: 0");
    expect(ruleBody(".mob-triage-title")).toContain("overflow-wrap: anywhere");
  });

  it("sizes the triage action buttons for touch", () => {
    expect(ruleBody(".mob-mini-btn")).toContain("min-height: 40px");
    expect(ruleBody(".mob-mini-btn--primary")).toContain("var(--status-success)");
  });

  it("styles run history as a touch-sized card disclosure", () => {
    expect(ruleBody(".mob-run-history")).toContain("border-radius: 8px");
    expect(ruleBody(".mob-run-history > summary")).toContain("min-height: 44px");
    expect(ruleBody(".mob-run-history-body")).toContain("display: grid");
  });
});

describe("mobile.css live activity cues", () => {
  it("defines the live-state animations", () => {
    expect(css).toContain("@keyframes mob-live-glow");
    expect(css).toContain("@keyframes mob-live-ring");
  });

  it("animates the live status pill and live plan badge", () => {
    expect(ruleBody('.mob-status-pill[data-live="true"]')).toContain("mob-live-glow");
    expect(ruleBody('.mob-chat-tab span[data-live="true"]')).toContain("mob-live-glow");
  });

  it("animates the running status dots on plan and minion rows", () => {
    expect(ruleBody('.mob-minion-row[data-tone="running"] .mob-minion-dot')).toContain("mob-live-ring");
    expect(ruleBody('.mob-plan-row[data-tone="running"] .mob-plan-dot')).toContain("mob-live-ring");
  });

  it("disables the looping animations under prefers-reduced-motion", () => {
    const guard = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(guard).toContain("animation: none");
    expect(guard).toContain('.mob-status-pill[data-live="true"]');
    expect(guard).toContain('.mob-minion-row[data-tone="running"] .mob-minion-dot');
  });
});

describe("mobile.css chat density", () => {
  it("keeps auxiliary chat events denser than response bubbles", () => {
    const body = ruleBody([
      ".mob-message--tool",
      ".mob-message--system",
      ".mob-message--thinking",
    ].join(",\n"));

    expect(body).toContain("font-size: 11px");
    expect(body).toContain("box-shadow: none");

    const toggle = ruleBody(".mob-message-toggle");
    expect(toggle).toContain("grid-template-columns: auto minmax(0, 1fr)");
    expect(toggle).toContain("padding: 5px 8px");
  });

  it("truncates the body of a closed auxiliary row", () => {
    const body = ruleBody('.mob-message[data-expanded="false"] .mob-message-content');
    expect(body).toContain("overflow: hidden");
    expect(body).toContain("text-overflow: ellipsis");
    expect(body).toContain("white-space: nowrap");
  });

  it("uses a smaller icon for compact tool rows", () => {
    const body = ruleBody(".mob-tool-icon");
    expect(body).toContain("width: 16px");
    expect(body).toContain("height: 16px");
  });
});
