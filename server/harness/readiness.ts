import { getHarness, productionHarnesses } from "./index.ts";
import type {
  HarnessReadiness,
  HarnessReadinessProbe,
  HarnessReadinessSnapshot,
  HarnessReadinessState,
} from "./readiness-types.ts";

const CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

let cached: HarnessReadinessSnapshot | null = null;
let inFlight: Promise<HarnessReadinessSnapshot> | null = null;

const REMEDIATION: Record<string, Partial<Record<HarnessReadinessState, HarnessReadiness["remediation"]>>> = {
  claude: {
    runtime_missing: { label: "Install the Claude Agent SDK runtime" },
    unauthenticated: { label: "Sign in to Claude", command: "claude auth login" },
    probe_timeout: { label: "Retry the Claude authentication check" },
    probe_failed: { label: "Retry Claude sign-in", command: "claude auth login" },
  },
  codex: {
    runtime_missing: { label: "Install the Codex SDK runtime" },
    unauthenticated: { label: "Sign in to Codex", command: "codex login" },
    probe_timeout: { label: "Retry the Codex authentication check" },
    probe_failed: { label: "Retry Codex sign-in", command: "codex login" },
  },
};

function fallbackProbe(source: "env_override" | "sdk_bundled"): HarnessReadinessProbe {
  return {
    state: "probe_failed",
    runtime: { available: false, source },
    auth: { authenticated: false, source: "unknown" },
  };
}

async function probeHarness(name: string, check: (context: { signal: AbortSignal }) => Promise<HarnessReadinessProbe>): Promise<HarnessReadiness> {
  const started = Date.now();
  const controller = new AbortController();
  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    const error = new Error("Readiness probe timed out");
    error.name = "AbortError";
    rejectTimeout?.(error);
  }, PROBE_TIMEOUT_MS);
  timer.unref?.();
  let probe: HarnessReadinessProbe;
  try {
    probe = await Promise.race([check({ signal: controller.signal }), timeout]);
  } catch (error) {
    const source = process.env[name === "claude" ? "CLAUDE_CODE_PATH" : "CODEX_PATH"]
      ? "env_override"
      : "sdk_bundled";
    probe = fallbackProbe(source);
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      probe.state = "probe_timeout";
    }
  } finally {
    clearTimeout(timer);
  }
  const checkedAtMs = Date.now();
  const state = probe.state as HarnessReadinessState;
  const ready = state === "ready" && probe.runtime.available && probe.auth.authenticated;
  return {
    name,
    ready,
    state: ready ? "ready" : state,
    runtime: probe.runtime,
    auth: probe.auth,
    checkedAt: new Date(checkedAtMs).toISOString(),
    expiresAt: new Date(checkedAtMs + CACHE_MS).toISOString(),
    durationMs: checkedAtMs - started,
    ...(ready ? {} : { remediation: REMEDIATION[name]?.[state] }),
  };
}

async function collect(): Promise<HarnessReadinessSnapshot> {
  const testHarness = (() => {
    if (process.env["MINIONS_TEST_HARNESS"] !== "echo") return [];
    try {
      const harness = getHarness("echo");
      return harness.exposure === "test" ? [harness] : [];
    } catch {
      return [];
    }
  })();
  const harnesses = await Promise.all(
    [...productionHarnesses(), ...testHarness].map((harness) =>
      probeHarness(harness.name, (context) => harness.checkReadiness(context)),
    ),
  );
  const checkedAtMs = Date.now();
  const readyHarnesses = harnesses.filter((item) => item.ready).map((item) => item.name);
  return {
    schemaVersion: 1,
    checkedAt: new Date(checkedAtMs).toISOString(),
    expiresAt: new Date(checkedAtMs + CACHE_MS).toISOString(),
    ready: readyHarnesses.length > 0,
    readyHarnesses,
    harnesses,
  };
}

export async function getHarnessReadiness(opts: { fresh?: boolean } = {}): Promise<HarnessReadinessSnapshot> {
  if (!opts.fresh && cached && Date.parse(cached.expiresAt) > Date.now()) return cached;
  if (inFlight) return inFlight;
  inFlight = collect().then((snapshot) => {
    cached = snapshot;
    return snapshot;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

export function clearHarnessReadinessCache(): void {
  cached = null;
  inFlight = null;
}
