import type { ThinkingConfig } from "./session-host-config.ts";
import type { ImageAttachment } from "./session-host-types.ts";
import type { SandboxPolicy } from "../shared/workspace-contracts.ts";
import type { LeaderOrchestrationMode } from "../shared/task-graph-planning-contracts.ts";
import {
  DEFAULT_LEADER_PLANNING_BACKEND,
  defaultOrchestrationModeForBackend,
} from "../shared/leader-planning.ts";

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
  if (config.orchestrationMode === undefined) {
    config.orchestrationMode = defaultOrchestrationModeForBackend(
      DEFAULT_LEADER_PLANNING_BACKEND,
    );
  }
  const planningContext = input.prompt?.match(/<connected-context>[\s\S]*?<\/connected-context>/)?.[0];
  if (planningContext) {
    if (Buffer.byteLength(planningContext) > MAX_PLANNING_CONTEXT_BLOCK_BYTES) {
      throw new Error("invalid connected planning context: exceeds the 2 MiB snapshot limit");
    }
    config.planningContext = planningContext;
  }
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
