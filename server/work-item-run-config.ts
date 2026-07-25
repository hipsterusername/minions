import type { ThinkingConfig } from "./session-host-config.ts";
import type { ImageAttachment } from "./session-host-types.ts";

export interface PrimaryRunConfig {
  harness?: string;
  model?: string;
  permissionMode?: string;
  thinkingConfig?: ThinkingConfig;
  skillIds?: string[];
  skillValues?: Record<string, Record<string, string>>;
  systemPrompt?: string;
  attachments?: ImageAttachment[];
}

interface ConfigInput {
  harness?: string; model?: string; permissionMode?: string;
  thinkingConfig?: unknown; skillIds?: string[]; skillValues?: Record<string, Record<string, string>>;
  systemPrompt?: string; attachments?: unknown[];
}

export function resolvePrimaryRunConfig(previousJson: string | null, input: ConfigInput) {
  const previous = previousJson ? JSON.parse(previousJson) as PrimaryRunConfig : {};
  const config: PrimaryRunConfig = { ...previous };
  if (input.harness !== undefined) config.harness = input.harness;
  if (input.model !== undefined) config.model = input.model;
  if (input.permissionMode !== undefined) config.permissionMode = input.permissionMode;
  if (input.thinkingConfig !== undefined) config.thinkingConfig = input.thinkingConfig as ThinkingConfig;
  if (input.skillIds !== undefined) config.skillIds = input.skillIds;
  if (input.skillValues !== undefined) config.skillValues = input.skillValues;
  if (input.systemPrompt !== undefined) config.systemPrompt = input.systemPrompt;
  if (input.attachments !== undefined) config.attachments = input.attachments as ImageAttachment[];
  return { config, json: JSON.stringify(config) };
}

export function compatibleResumeId(
  previous: { session_id: string | null; run_config_json: string | null; harness_name: string } | null,
  next: PrimaryRunConfig,
): string | undefined {
  if (!previous?.session_id) return undefined;
  const prior = previous.run_config_json
    ? JSON.parse(previous.run_config_json) as PrimaryRunConfig
    : { harness: previous.harness_name };
  return prior.harness === undefined || prior.harness === next.harness
    ? previous.session_id : undefined;
}
