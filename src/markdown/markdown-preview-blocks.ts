export type MarkdownPreviewBlock =
  | {
      id: string;
      type: "heading";
      rawText: string;
      text: string;
      level: number;
      from: number;
      to: number;
    }
  | {
      id: string;
      type: "paragraph" | "blockquote" | "rule" | "spacer" | "code";
      rawText: string;
      text: string;
      from: number;
      to: number;
    }
  | {
      id: string;
      type: "list";
      rawText: string;
      ordered: boolean;
      from: number;
      to: number;
      items: MarkdownPreviewListItem[];
    };

export interface MarkdownPreviewListItem {
  id: string;
  rawText: string;
  text: string;
  from: number;
  to: number;
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
  next: number;
}

const ORDERED_LIST_RE = /^\s*\d+[.)]\s+(.+)$/;
const UNORDERED_LIST_RE = /^\s*[-*+]\s+(.+)$/;

function readSourceLines(source: string): SourceLine[] {
  if (source.length === 0) return [];

  const lines: SourceLine[] = [];
  let start = 0;

  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) {
      lines.push({
        text: source.slice(start),
        start,
        end: source.length,
        next: source.length,
      });
      break;
    }

    const end = newline > start && source[newline - 1] === "\r"
      ? newline - 1
      : newline;
    lines.push({
      text: source.slice(start, end),
      start,
      end,
      next: newline + 1,
    });
    start = newline + 1;
  }

  if (source.endsWith("\n")) {
    lines.push({
      text: "",
      start: source.length,
      end: source.length,
      next: source.length,
    });
  }

  return lines;
}

function listItemText(line: string): { ordered: boolean; text: string } | null {
  const ordered = line.match(ORDERED_LIST_RE);
  if (ordered?.[1]) return { ordered: true, text: ordered[1] };

  const unordered = line.match(UNORDERED_LIST_RE);
  if (unordered?.[1]) return { ordered: false, text: unordered[1] };

  return null;
}

function blockId(type: string, from: number, to: number): string {
  return `${type}-${from}-${to}`;
}

export function parseMarkdownPreviewBlocks(source: string): MarkdownPreviewBlock[] {
  const lines = readSourceLines(source);
  const blocks: MarkdownPreviewBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;

    if (line.text.trimStart().startsWith("```")) {
      const startLine = line;
      const codeLines: SourceLine[] = [];
      i += 1;

      while (i < lines.length && !lines[i]?.text.trimStart().startsWith("```")) {
        const codeLine = lines[i];
        if (codeLine) codeLines.push(codeLine);
        i += 1;
      }

      const closingLine = i < lines.length ? lines[i] : undefined;
      if (closingLine) i += 1;

      const to =
        closingLine?.next ??
        codeLines[codeLines.length - 1]?.next ??
        startLine.next;
      blocks.push({
        id: blockId("code", startLine.start, to),
        type: "code",
        rawText: source.slice(startLine.start, to).trimEnd(),
        text: codeLines.map((codeLine) => codeLine.text).join("\n"),
        from: startLine.start,
        to,
      });
      continue;
    }

    const heading = line.text.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length;
      blocks.push({
        id: blockId("heading", line.start, line.end),
        type: "heading",
        rawText: line.text,
        text: heading[2],
        level,
        from: line.start,
        to: line.end,
      });
      i += 1;
      continue;
    }

    const listItem = listItemText(line.text);
    if (listItem) {
      const ordered = listItem.ordered;
      const items: MarkdownPreviewListItem[] = [];
      const startLine = line;

      while (i < lines.length) {
        const current = lines[i];
        if (!current) break;
        const parsed = listItemText(current.text);
        if (!parsed || parsed.ordered !== ordered) break;

        items.push({
          id: blockId("list-item", current.start, current.end),
          rawText: current.text,
          text: parsed.text,
          from: current.start,
          to: current.end,
        });
        i += 1;
      }

      const lastItem = items[items.length - 1];
      const to = lastItem?.to ?? startLine.end;
      blocks.push({
        id: blockId(ordered ? "ordered-list" : "list", startLine.start, to),
        type: "list",
        rawText: source.slice(startLine.start, to),
        ordered,
        from: startLine.start,
        to,
        items,
      });
      continue;
    }

    if (/^>\s+/.test(line.text)) {
      blocks.push({
        id: blockId("blockquote", line.start, line.end),
        type: "blockquote",
        rawText: line.text,
        text: line.text.replace(/^>\s+/, ""),
        from: line.start,
        to: line.end,
      });
      i += 1;
      continue;
    }

    if (line.text.startsWith("---")) {
      blocks.push({
        id: blockId("rule", line.start, line.end),
        type: "rule",
        rawText: line.text,
        text: "",
        from: line.start,
        to: line.end,
      });
      i += 1;
      continue;
    }

    if (line.text.trim() === "") {
      blocks.push({
        id: blockId("spacer", line.start, line.end),
        type: "spacer",
        rawText: line.text,
        text: "",
        from: line.start,
        to: line.end,
      });
      i += 1;
      continue;
    }

    blocks.push({
      id: blockId("paragraph", line.start, line.end),
      type: "paragraph",
      rawText: line.text,
      text: line.text,
      from: line.start,
      to: line.end,
    });
    i += 1;
  }

  return blocks;
}
