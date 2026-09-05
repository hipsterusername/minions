/** Bounded handoff text always signals omissions and preserves both ends. */
export function boundHandoffText(text: string, max: number): string {
  max = Math.max(0, Math.floor(max));
  if (text.length <= max) return text;
  const marker = "\n[... omitted by handoff budget; consult the original source ...]\n";
  if (max <= marker.length) return marker.slice(0, max);
  const head = Math.ceil((max - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(-(max - marker.length - head));
}

/** Reserve the first request independently of rolling follow-up instructions. */
export function retainUserDirectives(values: readonly string[], max = 12_000): string[] {
  const unique = values.map(value => value.trim()).filter(Boolean)
    .filter((value, index, rows) => index === 0 || value !== rows[index - 1]);
  if (!unique.length) return [];
  const first = boundHandoffText(unique[0]!, Math.floor(max / 2));
  const recent: string[] = [];
  let remaining = max - first.length - 100;
  for (let index = unique.length - 1; index > 0; index--) {
    const value = unique[index]!;
    if (value.length > remaining) {
      if (remaining > 150) recent.unshift(boundHandoffText(value, remaining));
      if (index > 1) recent.unshift("[Earlier follow-up instructions omitted by handoff budget.]");
      break;
    }
    recent.unshift(value);
    remaining -= value.length;
  }
  return [first, ...recent];
}

/** Generated history and connected sources have their own handoff sections. */
export function userTextFromPrompt(prompt: string): string {
  return prompt.replace(/<(context-checkpoint|previous-run-context|previous-session-context|session-continuation|context-window-recovery|connected-context|context-update)\b[^>]*>[\s\S]*?<\/\1>/g, "").trim();
}

/** The UI pins user instructions before its lossy conversation-history section. */
export function inheritedUserDirectives(prompt: string): string[] {
  const history = prompt.match(/<(previous-session-context|session-continuation|context-window-recovery)>([\s\S]*?)<\/\1>/)?.[2];
  const pinned = history?.split(/<task-plan>|<conversation-history>/)[0]
    ?.match(/<user-directives>([\s\S]*?)<\/user-directives>/)?.[1];
  return pinned ? pinned.trim().split("\n\n").map(value => value.trim()).filter(Boolean) : [];
}

/** Keep the source boundary intact even when a large snapshot exceeds its budget. */
export function renderConnectedHandoff(snapshot: string, sourceRef?: string): string {
  const content = snapshot.replace(/^<connected-context>\s*/, "").replace(/\s*<\/connected-context>$/, "");
  return `<connected-context>\n${renderSourceExcerpt(content, 24_000, sourceRef)}\n</connected-context>`;
}

/** Source references must be resolved by the producer, never guessed by a renderer. */
export function renderSourceExcerpt(text: string, max: number, sourceRef?: string, marker = "[... source content omitted ...]"): string {
  if (text.length <= max) return text;
  const provenance = sourceRef ? `Full source (reference data): ${sourceRef}`
    : "Full source unavailable to this renderer; request missing context from the Leader.";
  const footer = `\n${marker}\n${provenance}`;
  if (footer.length >= max) return boundHandoffText(footer, max);
  return boundHandoffText(text, max - footer.length) + footer;
}
