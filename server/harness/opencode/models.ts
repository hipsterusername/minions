const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

let availableModels: ReadonlyArray<{ id: string; label: string }> = [];

/** Parse `opencode models`, whose stable wire format is one provider/model per line. */
export function parseOpenCodeModels(stdout: string): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const models: Array<{ id: string; label: string }> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const id = rawLine.replace(ANSI_ESCAPE, "").trim();
    if (!id || /\s/.test(id) || !id.includes("/") || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

export function setOpenCodeModels(models: ReadonlyArray<{ id: string; label: string }>): void {
  availableModels = [...models];
}

export function getOpenCodeModels(): ReadonlyArray<{ id: string; label: string }> {
  return availableModels;
}

/** OpenCode accepts canonical provider/model ids without alias expansion. */
export function resolveOpenCodeModel(model: string | null | undefined): string | null {
  return model?.trim() || null;
}
