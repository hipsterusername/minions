export interface ParsedYaml {
  value: unknown;
  errors: string[];
}

export function parseYamlSubset(text: string): ParsedYaml {
  try {
    return { value: parseBlock(cleanLines(text), 0).value, errors: [] };
  } catch (err) {
    return { value: null, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

interface Line {
  indent: number;
  text: string;
}

function cleanLines(text: string): Line[] {
  return text.split(/\r?\n/)
    .map((raw) => ({ indent: raw.match(/^ */)?.[0].length ?? 0, text: raw.trim() }))
    .filter((line) => line.text.length > 0 && !line.text.startsWith("#"));
}

function parseBlock(lines: Line[], start: number): { value: unknown; next: number } {
  if (start >= lines.length) return { value: {}, next: start };
  return lines[start]!.text.startsWith("- ")
    ? parseList(lines, start, lines[start]!.indent)
    : parseMap(lines, start, lines[start]!.indent);
}

function parseMap(lines: Line[], start: number, indent: number) {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`Unexpected indentation at "${line.text}"`);
    const idx = line.text.indexOf(":");
    if (idx < 1) throw new Error(`Expected key: value at "${line.text}"`);
    const key = line.text.slice(0, idx).trim();
    const rest = line.text.slice(idx + 1).trim();
    if (rest === "") {
      const child = parseBlock(lines, i + 1);
      out[toCamel(key)] = child.value;
      i = child.next;
    } else {
      out[toCamel(key)] = parseScalar(rest);
      i += 1;
    }
  }
  return { value: out, next: i };
}

function parseList(lines: Line[], start: number, indent: number) {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`Unexpected indentation at "${line.text}"`);
    if (!line.text.startsWith("- ")) break;
    const item = line.text.slice(2).trim();
    if (item === "") {
      const child = parseBlock(lines, i + 1);
      out.push(child.value);
      i = child.next;
    } else if (item.includes(": ") && !item.startsWith("\"") && !item.startsWith("'")) {
      const childLines = [
        { indent: 0, text: item },
        ...collectIndented(lines, i + 1, indent)
          .map((child) => ({ ...child, indent: child.indent - indent - 2 })),
      ];
      const child = parseMap(childLines, 0, 0);
      out.push(child.value);
      i += childLines.length;
    } else {
      out.push(parseScalar(item));
      i += 1;
    }
  }
  return { value: out, next: i };
}

function collectIndented(lines: Line[], start: number, parentIndent: number): Line[] {
  const out: Line[] = [];
  for (let i = start; i < lines.length && lines[i]!.indent > parentIndent; i += 1) {
    out.push(lines[i]!);
  }
  return out;
}

function parseScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    return inner ? inner.split(",").map((part) => parseScalar(part.trim())) : [];
  }
  if (
    (raw.startsWith("\"") && raw.endsWith("\"")) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function toCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
