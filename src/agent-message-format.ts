export type AgentJson = string | number | boolean | null | AgentJson[] | { [key: string]: AgentJson };

/** Recognize standalone JSON only; prose and fenced code are intentional text. */
export function parseAgentJson(text: string): { value: AgentJson } | null {
  if (!/^[\s]*[\[{\"]/.test(text)) return null;
  try {
    let value: AgentJson = JSON.parse(text);
    // Provider/tool envelopes sometimes serialize the report more than once.
    for (let i = 0; i < 3 && typeof value === "string" && /^[\s]*[\[{\"]/.test(value); i++) {
      try { value = JSON.parse(value); } catch { break; }
    }
    return { value };
  } catch {
    return null;
  }
}

export function agentFieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, (_, before: string, after: string) => `${before} ${after.toLowerCase()}`)
    .replace(/[_-]+/g, " ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : '""';
}

/** Plain text for compact previews. Full reports retain every field in the renderer. */
export function agentJsonText(value: AgentJson, depth = 0): string {
  if (depth >= 6) return JSON.stringify(value);
  if (typeof value === "string") {
    const nested = parseAgentJson(value);
    return nested ? agentJsonText(nested.value, depth + 1) : value || '""';
  }
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(item => agentJsonText(item, depth + 1)).join("\n") : "[]";
  const fields = Object.entries(value);
  return fields.length ? fields.map(([key, item]) => `${agentFieldLabel(key)}: ${agentJsonText(item, depth + 1)}`).join("\n") : "{}";
}

export function agentMessagePreview(text: string): string {
  const parsed = parseAgentJson(text);
  if (parsed?.value !== null && typeof parsed?.value === "object") {
    return "Agent report available. Open session to view details.";
  }
  return parsed ? agentJsonText(parsed.value) : text;
}
