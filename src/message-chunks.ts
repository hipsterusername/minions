export type MessageChunkType = "heading" | "paragraph" | "list" | "code";

export interface MessageChunk {
  id: string;
  type: MessageChunkType;
  rawText: string;
}

function isFence(line: string): boolean {
  return line.trimStart().startsWith("```");
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line);
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+|•\s+)\S/.test(line);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function createChunk(
  type: MessageChunkType,
  index: number,
  lines: string[],
): MessageChunk {
  return {
    id: `${type}-${index}`,
    type,
    rawText: lines.join("\n").trim(),
  };
}

/**
 * Split a message into copyable semantic chunks while preserving source
 * markdown. The renderer may style markdown, but context copying should keep
 * the exact markdown-ish text the model produced.
 */
export function parseMessageChunks(text: string): MessageChunk[] {
  const lines = text.split("\n");
  const chunks: MessageChunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    if (isFence(line)) {
      const start = i;
      i += 1;
      while (i < lines.length && !isFence(lines[i] ?? "")) i += 1;
      if (i < lines.length) i += 1;
      chunks.push(createChunk("code", chunks.length, lines.slice(start, i)));
      continue;
    }

    if (isHeading(line)) {
      chunks.push(createChunk("heading", chunks.length, [line]));
      i += 1;
      continue;
    }

    if (isListItem(line)) {
      const start = i;
      i += 1;
      while (i < lines.length && isListItem(lines[i] ?? "")) i += 1;
      chunks.push(createChunk("list", chunks.length, lines.slice(start, i)));
      continue;
    }

    const start = i;
    i += 1;
    while (
      i < lines.length &&
      !isBlank(lines[i] ?? "") &&
      !isFence(lines[i] ?? "") &&
      !isHeading(lines[i] ?? "") &&
      !isListItem(lines[i] ?? "")
    ) {
      i += 1;
    }
    chunks.push(createChunk("paragraph", chunks.length, lines.slice(start, i)));
  }

  return chunks.filter((chunk) => chunk.rawText.length > 0);
}

export function joinSelectedChunks(
  chunks: readonly MessageChunk[],
  selectedIds: ReadonlySet<string>,
): string {
  return chunks
    .filter((chunk) => selectedIds.has(chunk.id))
    .map((chunk) => chunk.rawText)
    .join("\n\n");
}
