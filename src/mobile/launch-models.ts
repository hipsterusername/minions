/**
 * Model options for the mobile Launch screen.
 *
 * The launch dropdown lists models from *every* registered harness — not just
 * the default one — so OpenAI (the `codex` harness) and any other provider
 * appear alongside Anthropic. Because a model id is only meaningful to its own
 * harness, each option encodes `harness::modelId`; `parseLaunchModelValue`
 * decodes it back so `create_session` can send both the model and the harness
 * that resolves it.
 */

import type { HarnessInfo } from "../harness-list.ts";

/** Separator between harness name and model id in an encoded option value. */
const OPTION_SEP = "::";

export interface LaunchModelOption {
  /** Encoded `<option value>`: `${harness}::${id}`. */
  value: string;
  harness: string;
  id: string;
  label: string;
}

export interface LaunchModelGroup {
  harness: string;
  /** Provider display label, e.g. "Anthropic", "OpenAI". */
  label: string;
  options: LaunchModelOption[];
}

function titleCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Human-facing provider label for a harness. Mirrors the desktop
 * `SessionToolbar` mapping so both surfaces read the same.
 */
export function launchModelProviderLabel(harness: HarnessInfo): string {
  const provider = String(harness.account?.provider ?? harness.name).toLowerCase();
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic" || provider === "claude") return "Anthropic";
  if (provider === "echo") return "Echo";
  return titleCase(harness.name);
}

/**
 * Build one option group per harness that exposes at least one model,
 * preserving harness order. Harnesses with no models are omitted.
 */
export function buildLaunchModelGroups(
  harnesses: ReadonlyArray<HarnessInfo>,
): LaunchModelGroup[] {
  return harnesses.flatMap((harness) => {
    if (harness.models.length === 0) return [];
    return [
      {
        harness: harness.name,
        label: launchModelProviderLabel(harness),
        options: harness.models.map((model) => ({
          value: `${harness.name}${OPTION_SEP}${model.id}`,
          harness: harness.name,
          id: model.id,
          label: model.label,
        })),
      },
    ];
  });
}

/**
 * Decode an encoded option value into its harness + model. Returns `null` for
 * the empty ("Default") value or any malformed input.
 */
export function parseLaunchModelValue(
  value: string,
): { harness: string; model: string } | null {
  if (!value) return null;
  const index = value.indexOf(OPTION_SEP);
  if (index < 0) return null;
  const harness = value.slice(0, index);
  const model = value.slice(index + OPTION_SEP.length);
  if (!harness || !model) return null;
  return { harness, model };
}
