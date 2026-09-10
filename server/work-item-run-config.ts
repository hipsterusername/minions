import type { ThinkingConfig } from "./session-host-config.ts";
import type { ImageAttachment } from "./session-host-types.ts";
import type { SandboxPolicy } from "../shared/workspace-contracts.ts";
import type { LeaderOrchestrationMode } from "../shared/task-graph-planning-contracts.ts";
import {
  normalizeLeaderOrchestrationMode,
} from "../shared/leader-planning.ts";

import { inheritedUserDirectives, retainUserDirectives, userTextFromPrompt } from "../shared/handoff-text.ts";

const MAX_PLANNING_CONTEXT_BLOCK_BYTES = 2 * 1024 * 1024;

export interface PrimaryRunConfig {
  harness?: string;
  model?: string;
  permissionMode?: string;
  sandboxPolicy?: SandboxPolicy;
  thinkingConfig?: ThinkingConfig;
  skillIds?: string[];
  skillValues?: Record<string, Record<string, string>>;
  systemPrompt?: string;
  attachments?: ImageAttachment[];
  orchestrationMode?: LeaderOrchestrationMode;
  planningContext?: string;
  userDirectives?: string[];
}

interface ConfigInput {
  harness?: string; model?: string; permissionMode?: string; sandboxPolicy?: SandboxPolicy;
  thinkingConfig?: unknown; skillIds?: string[]; skillValues?: Record<string, Record<string, string>>;
  systemPrompt?: string; attachments?: unknown[];
  orchestrationMode?: LeaderOrchestrationMode; prompt?: string;
}

export function resolvePrimaryRunConfig(previousJson: string | null, input: ConfigInput) {
  const previous = previousJson ? JSON.parse(previousJson) as PrimaryRunConfig : {};
  const config: PrimaryRunConfig = { ...previous };
  if (input.harness !== undefined) config.harness = input.harness;
  if (input.model !== undefined) config.model = input.model;
  if (input.permissionMode !== undefined) config.permissionMode = input.permissionMode;
  if (input.sandboxPolicy !== undefined) config.sandboxPolicy = input.sandboxPolicy;
  if (input.thinkingConfig !== undefined) config.thinkingConfig = input.thinkingConfig as ThinkingConfig;
  if (input.skillIds !== undefined) config.skillIds = input.skillIds;
  if (input.skillValues !== undefined) config.skillValues = input.skillValues;
  if (input.systemPrompt !== undefined) config.systemPrompt = input.systemPrompt;
  if (input.attachments !== undefined) config.attachments = input.attachments as ImageAttachment[];
  if (input.orchestrationMode !== undefined) config.orchestrationMode = input.orchestrationMode;
  config.orchestrationMode = normalizeLeaderOrchestrationMode(config.orchestrationMode);
  config.userDirectives = retainUserDirectives([...(previous.userDirectives ?? []), ...inheritedUserDirectives(input.prompt ?? ""), userTextFromPrompt(input.prompt ?? "")]);
  const planningContext = input.prompt?.match(/<connected-context>[\s\S]*?<\/connected-context>/)?.[0];
  if (planningContext) {
    if (Buffer.byteLength(planningContext) > MAX_PLANNING_CONTEXT_BLOCK_BYTES) {
      throw new Error("invalid connected planning context: exceeds the 2 MiB snapshot limit");
    }
    config.planningContext = planningContext;
  }
  return { config, json: JSON.stringify(config) };
}

interface PreviousRunConfig {
  run_config_json: string | null;
  harness_name: string;
  model?: string | null;
}

export function inheritedPrimaryRunConfig(previous: PreviousRunConfig): PrimaryRunConfig {
  const stored = previous.run_config_json ? JSON.parse(previous.run_config_json) as PrimaryRunConfig : {};
  // Before a host initializes, the row has a placeholder harness and no model.
  // Once it resolves a model, the actual selection supersedes requested settings
  // (which may have fallen back or been changed during the run).
  return { ...stored,
    harness: previous.model ? previous.harness_name : stored.harness ?? previous.harness_name,
    ...(previous.model ? { model: previous.model } : {}),
  };
}

export function compatibleResumeId(
  previous: (PreviousRunConfig & { session_id: string | null }) | null,
  next: PrimaryRunConfig,
): string | undefined {
  if (!previous?.session_id) return undefined;
  return inheritedPrimaryRunConfig(previous).harness === next.harness
    ? previous.session_id : undefined;
}
