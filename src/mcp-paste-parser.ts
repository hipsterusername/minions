/**
 * Parse a pasted MCP server config into a draft entry the form can prefill.
 *
 * Vendors publish MCP server install instructions in one of four shapes:
 *
 *   1. A bare subprocess command:
 *      `npx -y @modelcontextprotocol/server-filesystem ~/Documents`
 *   2. A `claude mcp add` CLI invocation:
 *      `claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ~`
 *   3. A JSON blob, either a single entry, our own schema, or a
 *      Claude-Desktop / `.mcp.json`-style `{"mcpServers": {...}}` wrapper.
 *   4. A bare HTTPS URL for a hosted (HTTP/SSE) server.
 *
 * This module accepts any of those, runs purely (no I/O, no spawn), and
 * returns a partial draft suitable for prefilling McpServersBrowser's form.
 *
 * Security:
 *  - Hard-caps input length so a giant paste cannot wedge the UI.
 *  - Rejects unquoted shell metacharacters (`|`, `&`, `;`, `<`, `>`, `` ` ``,
 *    `$(`) in subprocess form. They almost always indicate a shell pipeline
 *    that wouldn't survive being passed to `spawn` in argv form anyway, and
 *    refusing them makes the failure visible instead of silent.
 *  - JSON is parsed with `JSON.parse`; no `eval`, no `require`.
 *  - Env / header values are preserved verbatim — no shell expansion.
 *  - The parser never executes anything. Validation against the strict zod
 *    schema happens later, in the store, before disk write.
 */

// ── Public types ────────────────────────────────────────────────────────────

export type PasteTransport = "stdio" | "sse" | "http";

/**
 * Partial form draft. Mirrors the field shape of `DraftEntry` in
 * McpServersBrowser so the form can spread it directly. Only fields the
 * parser could infer are present; the user fills the rest before saving.
 */
export interface PastedDraft {
  id?: string;
  name?: string;
  description?: string;
  transport: PasteTransport;
  // stdio
  command?: string;
  args?: string;
  env?: string;
  // sse / http
  url?: string;
  headers?: string;
  // shared optional
  toolNames?: string;
}

export type PasteParseResult =
  | { ok: true; draft: PastedDraft; warnings: string[] }
  | { ok: false; error: string };

// ── Limits ──────────────────────────────────────────────────────────────────

/** Max accepted paste size in bytes. 8 KiB is huge for an install line. */
export const MAX_PASTE_BYTES = 8 * 1024;

/** Shell metacharacters that signal a pipeline rather than a single command. */
const SHELL_METACHAR_RE = /[|&;<>`]|\$\(/;

// ── Entry point ─────────────────────────────────────────────────────────────

export function parsePastedMcpConfig(raw: string): PasteParseResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Paste must be a string." };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Paste is empty." };
  if (trimmed.length > MAX_PASTE_BYTES) {
    return {
      ok: false,
      error: `Paste exceeds ${MAX_PASTE_BYTES} bytes (got ${trimmed.length}).`,
    };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonForm(trimmed);
  }

  // Lone URL → HTTP transport.
  if (isLoneUrl(trimmed)) {
    return {
      ok: true,
      warnings: [],
      draft: { transport: "http", url: trimmed },
    };
  }

  if (looksLikeClaudeAddCommand(trimmed)) {
    return parseClaudeAddCommand(trimmed);
  }

  return parseBareSubprocess(trimmed);
}

// ── URL detection ───────────────────────────────────────────────────────────

function isLoneUrl(s: string): boolean {
  if (/\s/.test(s)) return false;
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

// ── Bare subprocess: `npx -y @scope/pkg --foo bar` ──────────────────────────

function parseBareSubprocess(input: string): PasteParseResult {
  const tokens = tokenizeShell(input);
  if (!tokens.ok) return { ok: false, error: tokens.error };
  const command = tokens.tokens[0];
  if (command === undefined) {
    return { ok: false, error: "No command found in paste." };
  }
  const args = tokens.tokens.slice(1);
  const draft: PastedDraft = {
    transport: "stdio",
    command,
    args: joinArgs(args),
  };
  if (tokens.warnings.length > 0) {
    return { ok: true, draft, warnings: tokens.warnings };
  }
  return { ok: true, draft, warnings: [] };
}

// ── `claude mcp add ...` parser ─────────────────────────────────────────────

function looksLikeClaudeAddCommand(s: string): boolean {
  // Be permissive: `claude mcp add ...`, `claude mcp add-json ...`,
  // and the `npx @anthropic-ai/claude-code mcp add ...` variant.
  return /^(npx\s+@anthropic-ai\/claude-code|claude)\s+mcp\s+add(-json)?\b/.test(
    s,
  );
}

function parseClaudeAddCommand(input: string): PasteParseResult {
  const tokens = tokenizeShell(input);
  if (!tokens.ok) return { ok: false, error: tokens.error };

  // Strip the `claude mcp add[-json]` (or `npx ... mcp add[-json]`) prefix.
  // We already matched the regex, so we know the relevant tokens exist;
  // still walk defensively.
  const t = [...tokens.tokens];
  if (t[0] === "npx" && t[1] === "@anthropic-ai/claude-code") {
    t.splice(0, 2);
  } else if (t[0] === "claude") {
    t.splice(0, 1);
  } else {
    return { ok: false, error: "Expected a `claude mcp add` command." };
  }
  const head: string | undefined = t[0];
  if (head !== "mcp") {
    return { ok: false, error: "Expected `mcp` after the CLI prefix." };
  }
  const verb = t[1];
  if (verb !== "add" && verb !== "add-json") {
    return { ok: false, error: "Expected `claude mcp add` or `add-json`." };
  }
  t.splice(0, 2);

  const warnings: string[] = [...tokens.warnings];
  const draft: PastedDraft = { transport: "stdio" };

  // Walk flags up to the positional name.
  let name: string | undefined;
  let urlPositional: string | undefined;
  let subprocess: string[] | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let explicitTransport: PasteTransport | undefined;

  let i = 0;
  while (i < t.length) {
    const tok = t[i];
    if (tok === undefined) break;

    if (tok === "--") {
      subprocess = t.slice(i + 1);
      break;
    }
    if (tok === "--transport") {
      const v = t[i + 1];
      if (v === "stdio" || v === "sse" || v === "http") {
        explicitTransport = v;
      } else {
        warnings.push(`Ignored unknown transport: ${String(v)}`);
      }
      i += 2;
      continue;
    }
    if (tok === "--env" || tok === "-e") {
      const kv = t[i + 1] ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
      else warnings.push(`Skipped malformed --env value: ${kv}`);
      i += 2;
      continue;
    }
    if (tok === "--header" || tok === "-H") {
      const hv = t[i + 1] ?? "";
      // Headers use HTTP-style "K: V" rather than KEY=VAL.
      const colon = hv.indexOf(":");
      if (colon > 0) {
        headers[hv.slice(0, colon).trim()] = hv.slice(colon + 1).trim();
      } else {
        warnings.push(`Skipped malformed --header value: ${hv}`);
      }
      i += 2;
      continue;
    }
    if (tok === "--scope" || tok === "-s") {
      // Scope is not relevant on import — Minions has its own scope model.
      i += 2;
      continue;
    }
    if (tok === "--client-id" || tok === "--client-secret") {
      // OAuth credentials skipped on import; user re-enters in the OAuth UI.
      warnings.push(`Skipped OAuth flag on import: ${tok}`);
      i += 2;
      continue;
    }
    if (tok.startsWith("--")) {
      // Generic skip-with-value heuristic for forward-compat.
      warnings.push(`Skipped unknown flag: ${tok}`);
      const next = t[i + 1];
      if (next !== undefined && !next.startsWith("--")) i += 2;
      else i += 1;
      continue;
    }

    // Positional. First positional = name. For `add-json`, second = json.
    if (name === undefined) {
      name = tok;
      i += 1;
      continue;
    }
    if (verb === "add-json") {
      // Remaining tokens are the JSON blob; rejoin with spaces (tokenizer
      // preserved quoted strings as single tokens, so this is safe).
      const json = t.slice(i).join(" ");
      const inner = parseJsonForm(json);
      if (!inner.ok) return inner;
      // Fold the explicit name into the inner draft.
      const merged: PastedDraft = { ...inner.draft };
      if (!merged.id) merged.id = sanitizeId(name);
      if (!merged.name) merged.name = name;
      return { ok: true, draft: merged, warnings: [...warnings, ...inner.warnings] };
    }
    // For `add`, the remaining positional may be a URL.
    urlPositional = tok;
    i += 1;
  }

  if (name) {
    draft.id = sanitizeId(name);
    draft.name = name;
  }

  // Decide the transport.
  const subCommand = subprocess?.[0];
  if (subprocess && subCommand !== undefined) {
    draft.transport = "stdio";
    draft.command = subCommand;
    if (subprocess.length > 1) draft.args = joinArgs(subprocess.slice(1));
    if (Object.keys(env).length > 0) draft.env = formatKvLines(env);
  } else if (urlPositional) {
    draft.transport = explicitTransport ?? "http";
    draft.url = urlPositional;
    if (Object.keys(headers).length > 0) draft.headers = formatKvLines(headers);
  } else {
    return {
      ok: false,
      error:
        "No command or URL found. Expected `-- <cmd> <args>` or a positional URL.",
    };
  }

  return { ok: true, draft, warnings };
}

// ── JSON parser ─────────────────────────────────────────────────────────────

function parseJsonForm(input: string): PasteParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid JSON: ${msg}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "JSON must be an object." };
  }

  const obj = parsed as Record<string, unknown>;

  // `.mcp.json` / Claude Desktop wrapped form: { "mcpServers": { name: {...} } }
  if (
    obj["mcpServers"] !== undefined &&
    typeof obj["mcpServers"] === "object" &&
    obj["mcpServers"] !== null &&
    !Array.isArray(obj["mcpServers"])
  ) {
    const servers = obj["mcpServers"] as Record<string, unknown>;
    const keys = Object.keys(servers);
    const firstKey = keys[0];
    if (firstKey === undefined) {
      return { ok: false, error: "`mcpServers` object is empty." };
    }
    const warnings: string[] =
      keys.length > 1
        ? [`Multiple servers in paste; using "${firstKey}". Paste each separately to add the rest.`]
        : [];
    const inner = entryObjectToDraft(servers[firstKey], firstKey);
    if (!inner.ok) return inner;
    return { ok: true, draft: inner.draft, warnings: [...warnings, ...inner.warnings] };
  }

  return entryObjectToDraft(parsed, undefined);
}

function entryObjectToDraft(
  raw: unknown,
  fallbackName: string | undefined,
): PasteParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Server entry must be a JSON object." };
  }
  const o = raw as Record<string, unknown>;
  const warnings: string[] = [];

  // Discriminant: explicit `transport`, `type`, or shape inference.
  const explicit =
    pickStringEnum(o["transport"], ["stdio", "sse", "http"]) ??
    pickStringEnum(o["type"], ["stdio", "sse", "http"]);
  const inferred: PasteTransport = explicit
    ? explicit
    : typeof o["url"] === "string"
      ? "http"
      : "stdio";

  const draft: PastedDraft = { transport: inferred };

  // Identity. Prefer explicit id, then `name`, then the wrapper key.
  const idCandidate =
    pickString(o["id"]) ?? pickString(o["name"]) ?? fallbackName;
  if (idCandidate) {
    draft.id = sanitizeId(idCandidate);
    draft.name = pickString(o["name"]) ?? fallbackName ?? idCandidate;
  }
  const desc = pickString(o["description"]);
  if (desc) draft.description = desc;

  // toolNames may be an array of strings.
  const toolNames = pickStringArray(o["toolNames"]);
  if (toolNames) draft.toolNames = toolNames.join(", ");

  if (inferred === "stdio") {
    const command = pickString(o["command"]);
    if (!command) {
      return { ok: false, error: "stdio entry is missing `command`." };
    }
    draft.command = command;
    const args = pickStringArray(o["args"]);
    if (args && args.length > 0) draft.args = joinArgs(args);
    const env = pickStringRecord(o["env"]);
    if (env && Object.keys(env).length > 0) draft.env = formatKvLines(env);
  } else {
    const url = pickString(o["url"]);
    if (!url) {
      return { ok: false, error: `${inferred} entry is missing \`url\`.` };
    }
    draft.url = url;
    const headers =
      pickStringRecord(o["headers"]) ?? pickHeaderArray(o["headers"]);
    if (headers && Object.keys(headers).length > 0) {
      draft.headers = formatKvLines(headers);
    }
  }

  return { ok: true, draft, warnings };
}

// ── Shell tokenizer ─────────────────────────────────────────────────────────

interface TokenizeOk {
  ok: true;
  tokens: string[];
  warnings: string[];
}
interface TokenizeErr {
  ok: false;
  error: string;
}

/**
 * Split a shell-style command line into argv tokens.
 *
 * Honors single and double quotes; double quotes allow `\\` and `\"` escapes.
 * Rejects unquoted shell metacharacters so a pasted pipeline fails loudly
 * rather than silently being passed to `spawn` argv-style.
 */
function tokenizeShell(input: string): TokenizeOk | TokenizeErr {
  const tokens: string[] = [];
  const warnings: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  const push = () => {
    if (hasContent) {
      tokens.push(cur);
      cur = "";
      hasContent = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
        hasContent = true;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === "\\") {
          cur += next;
          i += 1;
        } else {
          cur += ch;
        }
        hasContent = true;
      } else {
        cur += ch;
        hasContent = true;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      push();
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      // Outside quotes, treat backslash as a literal escape of the next char.
      cur += input[i + 1];
      hasContent = true;
      i += 1;
      continue;
    }
    if (SHELL_METACHAR_RE.test(ch + (input[i + 1] ?? ""))) {
      return {
        ok: false,
        error:
          "Unsupported shell metacharacter in paste. Pipelines, redirects, and command substitution aren't supported — paste a single command only.",
      };
    }

    cur += ch;
    hasContent = true;
  }

  if (inSingle || inDouble) {
    return { ok: false, error: "Unclosed quote in paste." };
  }
  push();

  return { ok: true, tokens, warnings };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function pickStringEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

function pickStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

function pickStringRecord(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") return undefined;
    out[k] = val;
  }
  return out;
}

/** Accept headers as ["Key: Value", ...] in addition to object form. */
function pickHeaderArray(v: unknown): Record<string, string> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const item of v) {
    if (typeof item !== "string") return undefined;
    const colon = item.indexOf(":");
    if (colon < 1) return undefined;
    out[item.slice(0, colon).trim()] = item.slice(colon + 1).trim();
  }
  return out;
}

function formatKvLines(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/**
 * Join argv tokens for the form's space-separated args field. Tokens that
 * contain whitespace get re-quoted so a round-trip through draftToEntry's
 * `split(/\s+/)` reproduces them faithfully.
 */
function joinArgs(args: readonly string[]): string {
  return args
    .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
}

/**
 * Split a single args input line into argv tokens, honoring single and
 * double quotes. Unlike {@link tokenizeShell}, this does NOT reject shell
 * metacharacters — they are valid literal characters in an args list.
 *
 * Used by the McpServersBrowser form so quoted args (e.g.
 * `--message "hello world"`) survive a save/load round-trip.
 */
export function splitArgsLine(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  const push = () => {
    if (hasContent) {
      tokens.push(cur);
      cur = "";
      hasContent = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else {
        cur += ch;
        hasContent = true;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === "\\") {
          cur += next;
          i += 1;
        } else {
          cur += ch;
        }
        hasContent = true;
      } else {
        cur += ch;
        hasContent = true;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      push();
      continue;
    }
    cur += ch;
    hasContent = true;
  }
  push();
  return tokens;
}

/**
 * Coerce an arbitrary name into a valid id per mcpServerEntrySchema:
 *   ^[a-z0-9][a-z0-9_-]*$
 * Anything else is replaced by `-`. If the result starts with a non-alnum
 * character, prefix with `s`.
 */
export function sanitizeId(name: string): string {
  let out = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  out = out.replace(/^-+/, "").replace(/-+$/, "");
  if (!out) return "server";
  if (!/^[a-z0-9]/.test(out)) out = `s${out}`;
  return out.slice(0, 80);
}
