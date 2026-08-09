import { createRequire } from "node:module";

type JsdomInstance = {
  window: Window & { document: Document };
};

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (input: string) => JsdomInstance;
};

const RESET_CSS =
  "html,body{margin:0;padding:8px;font-family:system-ui,sans-serif;color:#111;background:#fff;overflow:auto}img{max-width:100%}";

const ALLOWED_TAGS = new Set([
  "div",
  "span",
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "pre",
  "code",
  "kbd",
  "samp",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "mark",
  "abbr",
  "cite",
  "q",
  "time",
  "address",
  "article",
  "section",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "figure",
  "figcaption",
  "details",
  "summary",
  "wbr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "col",
  "img",
  "style",
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "use",
  "title",
  "desc",
  "symbol",
  "marker",
  "pattern",
]);

const DROP_SUBTREE_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "button",
  "label",
  "fieldset",
  "link",
  "base",
  "meta",
  "noscript",
  "template",
  "frame",
  "frameset",
  "marquee",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "math",
  "foreignobject",
]);

const GLOBAL_ATTRS = new Set([
  "class",
  "id",
  "title",
  "dir",
  "lang",
  "align",
  "valign",
  "width",
  "height",
  "colspan",
  "rowspan",
  "style",
]);

const IMG_ATTRS = new Set(["src", "alt"]);

const SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "use",
  "title",
  "desc",
  "symbol",
  "marker",
  "pattern",
]);

const SVG_ATTRS = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "viewbox",
  "preserveaspectratio",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "fx",
  "fy",
  "class",
  "id",
  "style",
]);

function sanitizeCss(css: string): string {
  return css
    .replace(/@import\b[^;{}]*(?:;|$)/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/behavior\s*:/gi, "")
    .replace(/-moz-binding\b/gi, "")
    .replace(/url\(\s*(["']?)(?!data:)[^)]+\)/gi, "")
    .replace(/position\s*:\s*(?:fixed|sticky)\s*;?/gi, "");
}

function isAllowedAttribute(tagName: string, attrName: string): boolean {
  const normalized = attrName.toLowerCase();
  return (
    GLOBAL_ATTRS.has(normalized) ||
    (tagName === "img" && IMG_ATTRS.has(normalized)) ||
    (SVG_TAGS.has(tagName) && SVG_ATTRS.has(normalized))
  );
}

function isDataUri(value: string): boolean {
  return value.trim().toLowerCase().startsWith("data:");
}

function sanitizeAttributes(element: Element, tagName: string): void {
  for (const attrName of element.getAttributeNames()) {
    const normalized = attrName.toLowerCase();
    const value = element.getAttribute(attrName) ?? "";

    if (normalized.startsWith("on") || !isAllowedAttribute(tagName, attrName)) {
      element.removeAttribute(attrName);
      continue;
    }

    if (normalized === "src" && (tagName !== "img" || !isDataUri(value))) {
      element.removeAttribute(attrName);
      continue;
    }

    if (normalized === "style") {
      const cleaned = sanitizeCss(value);
      if (cleaned.trim() === "") {
        element.removeAttribute(attrName);
      } else {
        element.setAttribute(attrName, cleaned);
      }
    }
  }
}

function unwrapElement(element: Element): void {
  const parent = element.parentNode;
  if (!parent) {
    return;
  }

  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  parent.removeChild(element);
}

function sanitizeElement(element: Element): void {
  const tagName = element.localName.toLowerCase();

  if (DROP_SUBTREE_TAGS.has(tagName)) {
    element.remove();
    return;
  }

  if (!ALLOWED_TAGS.has(tagName)) {
    // Unknown non-dangerous elements are unwrapped after their children are
    // sanitized so benign text survives without preserving custom behavior.
    sanitizeChildren(element);
    unwrapElement(element);
    return;
  }

  if (tagName === "style") {
    element.textContent = sanitizeCss(element.textContent ?? "");
  }

  sanitizeAttributes(element, tagName);
  sanitizeChildren(element);
}

function sanitizeChildren(parent: ParentNode): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === child.ELEMENT_NODE) {
      sanitizeElement(child as Element);
    }
  }
}

function removeComments(document: Document): void {
  const comments: Comment[] = [];
  const walker = document.createTreeWalker(document, 128);
  while (walker.nextNode()) {
    comments.push(walker.currentNode as Comment);
  }
  for (const comment of comments) {
    comment.remove();
  }
}

function relocateStylesToBody(document: Document): void {
  const body = document.body;
  const styles = Array.from(document.querySelectorAll("style")).filter(
    (style) => (style.textContent ?? "") !== RESET_CSS,
  );

  for (const style of styles.reverse()) {
    body.insertBefore(style, body.firstChild);
  }
}

export function sanitizeHtml(input: string): string {
  const dom = new JSDOM(input);
  const { document } = dom.window;

  removeComments(document);
  sanitizeChildren(document.head);
  sanitizeChildren(document.body);
  relocateStylesToBody(document);

  return document.body.innerHTML;
}

export function toSandboxDocument(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>${RESET_CSS}</style></head><body>${fragment}</body></html>`;
}

export function sanitizeToSandboxDocument(input: string): string {
  return toSandboxDocument(sanitizeHtml(input));
}
