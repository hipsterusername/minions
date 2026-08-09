const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

let availableModels: ReadonlyArray<{ id: string; label: string }> = [];

/** Parse the TSV emitted by `pi --list-models`. */
export function parsePiModels(stdout: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_ESCAPE, "").trim();
    if (!line || /^no models available/i.test(line)) continue;
    const columns = line.includes("\t") ? line.split("\t") : line.split(/\s{2,}/);
    const first = columns[0]?.trim() ?? "";
    const second = columns[1]?.trim() ?? "";
    if (/^provider$/i.test(first) && /^model/i.test(second)) continue;
    const id = first.includes("/") ? first : first && second ? `${first}/${second}` : "";
    if (!id || !id.includes("/") || seen.has(id)) continue;
    seen.add(id);
    const displayName = columns[2]?.trim();
    models.push({ id, label: displayName && !/^\d/.test(displayName) ? displayName : id });
  }
  return models;
}

export function setPiModels(models: ReadonlyArray<{ id: string; label: string }>): void {
  availableModels = [...models];
}

export function getPiModels(): ReadonlyArray<{ id: string; label: string }> {
  return availableModels;
}

export function resolvePiModel(model: string | null | undefined): string | null {
  return model?.trim() || null;
}
