export type HarnessReadinessState =
  | "ready"
  | "runtime_missing"
  | "unauthenticated"
  | "probe_timeout"
  | "probe_failed";

export type HarnessAuthSource = "api_key" | "oauth" | "cli_login" | "unknown";

export interface HarnessReadiness {
  name: string;
  ready: boolean;
  state: HarnessReadinessState;
  runtime: {
    available: boolean;
    source: "env_override" | "sdk_bundled";
    version?: string;
  };
  auth: { authenticated: boolean; source: HarnessAuthSource };
  checkedAt: string;
  expiresAt: string;
  durationMs: number;
  remediation?: { label: string; command?: string };
}

export interface HarnessReadinessSnapshot {
  schemaVersion: 1;
  checkedAt: string;
  expiresAt: string;
  ready: boolean;
  readyHarnesses: string[];
  harnesses: HarnessReadiness[];
}

export interface HarnessReadinessProbe {
  state: HarnessReadinessState;
  runtime: HarnessReadiness["runtime"];
  auth: HarnessReadiness["auth"];
}

export interface HarnessReadinessContext {
  signal: AbortSignal;
}
