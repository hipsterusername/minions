import { describe, expect, it } from "vitest";

import {
  sanitizeHtml,
  sanitizeToSandboxDocument,
  toSandboxDocument,
} from "./html-sanitize.ts";

describe("sanitizeHtml", () => {
  it("removes script elements entirely", () => {
    const output = sanitizeHtml("<p>safe</p><script>alert(1)</script>");

    expect(output).toContain("<p>safe</p>");
    expect(output).not.toContain("<script");
    expect(output).not.toContain("alert(1)");
  });

  it("removes image event handlers and non-data src values", () => {
    const output = sanitizeHtml('<img src=x onerror=alert(1) alt="x">');

    expect(output).toContain("<img");
    expect(output).toContain('alt="x"');
    expect(output).not.toContain("onerror");
    expect(output).not.toContain("src=");
  });

  it("unwraps anchors and removes javascript URLs", () => {
    const output = sanitizeHtml('<a href="javascript:alert(1)">click</a>');

    expect(output).toBe("click");
    expect(output).not.toContain("<a");
    expect(output).not.toContain("href");
    expect(output).not.toContain("javascript:");
  });

  it("removes functional and embedded content subtrees", () => {
    const output = sanitizeHtml(`
      <iframe src="https://evil.test">frame text</iframe>
      <object data="x">object text</object>
      <embed src="x">
      <form><input value="x"><button>go</button></form>
      <p>safe</p>
    `);

    expect(output).toContain("<p>safe</p>");
    expect(output).not.toContain("<iframe");
    expect(output).not.toContain("<object");
    expect(output).not.toContain("<embed");
    expect(output).not.toContain("<form");
    expect(output).not.toContain("<input");
    expect(output).not.toContain("<button");
    expect(output).not.toContain("frame text");
    expect(output).not.toContain("object text");
    expect(output).not.toContain("go");
  });

  it("removes inline event handlers on allowed elements", () => {
    const output = sanitizeHtml(`
      <div onclick="alert(1)">
        <span onmouseover="alert(2)">hover</span>
        <svg onload="alert(3)"><rect width="1" height="2"></rect></svg>
      </div>
    `);

    expect(output).toContain("<div>");
    expect(output).toContain("<span>hover</span>");
    expect(output).toContain("<svg><rect width=\"1\" height=\"2\"></rect></svg>");
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("onmouseover");
    expect(output).not.toContain("onload");
  });

  it("strips style imports and external url references", () => {
    const output = sanitizeHtml(`
      <style>@import url(http://evil); body { background: url(http://evil/bg.png); color: red; }</style>
    `);

    expect(output).toContain("<style>");
    expect(output).toContain("color: red");
    expect(output).not.toContain("@import");
    expect(output).not.toContain("http://evil");
    expect(output).not.toContain("url(http");
  });

  it("strips javascript urls and expression calls from inline styles", () => {
    const output = sanitizeHtml(
      '<div style="background:url(javascript:alert(1)); width: expression(alert(2)); color: blue; position:fixed">x</div>',
    );

    expect(output).toContain("color: blue");
    expect(output).not.toContain("javascript:");
    expect(output).not.toContain("expression");
    expect(output).not.toContain("position:fixed");
  });

  it("removes refresh meta tags", () => {
    const output = sanitizeHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.test"><p>safe</p>',
    );

    expect(output).toBe("<p>safe</p>");
    expect(output).not.toContain("<meta");
    expect(output).not.toContain("refresh");
  });

  it("sanitizes svg scripts and handlers while preserving benign svg", () => {
    const output = sanitizeHtml(
      '<svg onload="alert(1)"><script>alert(2)</script><rect width="10" height="20" fill="red"></rect></svg>',
    );

    expect(output).toBe('<svg><rect width="10" height="20" fill="red"></rect></svg>');
    expect(output).not.toContain("<script");
    expect(output).not.toContain("onload");
    expect(output).not.toContain("alert");
  });

  it("preserves data image src values", () => {
    const output = sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">');

    expect(output).toBe('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">');
  });

  it("preserves benign visualization content and data url styles", () => {
    const output = sanitizeHtml(`
      <html>
        <head>
          <style>.icon { background: url(data:image/png;base64,iVBORw0KGgo=); }</style>
        </head>
        <body>
          <h2 class="title">Report</h2>
          <ul><li><strong style="color: green">ok</strong></li></ul>
          <table><caption>Data</caption><tbody><tr><th>A</th><td align="right">1</td></tr></tbody></table>
        </body>
      </html>
    `);

    expect(output.trim().startsWith("<style>")).toBe(true);
    expect(output).toContain("url(data:image/png;base64,iVBORw0KGgo=)");
    expect(output).toContain('<h2 class="title">Report</h2>');
    expect(output).toContain('<strong style="color: green">ok</strong>');
    expect(output).toContain("<table>");
    expect(output).toContain("<th>A</th>");
    expect(output).toContain('<td align="right">1</td>');
  });

  it("removes HTML comments", () => {
    const output = sanitizeHtml("<div>a<!-- hidden --><span>b</span></div>");

    expect(output).toBe("<div>a<span>b</span></div>");
    expect(output).not.toContain("<!--");
  });
});

describe("toSandboxDocument", () => {
  it("wraps a fragment with doctype and CSP meta", () => {
    const output = toSandboxDocument("<p>safe</p>");

    expect(output.startsWith("<!doctype html>")).toBe(true);
    expect(output).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; base-uri \'none\'; form-action \'none\'">',
    );
    expect(output).toContain("<body><p>safe</p></body>");
  });
});

describe("sanitizeToSandboxDocument", () => {
  it("is idempotent", () => {
    const input = `
      <html>
        <head><style>.ok { color: red; }</style></head>
        <body><h1 onclick="x()">Hello</h1><script>alert(1)</script></body>
      </html>
    `;

    const once = sanitizeToSandboxDocument(input);
    const twice = sanitizeToSandboxDocument(once);

    expect(twice).toBe(once);
  });
});
