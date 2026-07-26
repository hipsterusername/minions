import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getProjectSettings,
  restartServer,
  updateProjectSettings,
  type ProjectSettings,
} from "../api.ts";
import { getModelCapability } from "../model-meta.ts";
import type { ServerMessage, SocketSubscribe } from "../use-socket.ts";
import {
  buildModelGroups,
  ModelSelect,
  normalizeThinkingConfig,
  normalizeThinkingForCapability,
  resolveModelSelection,
  ThinkingControls,
} from "../SettingsMenu.tsx";
import { findHarness } from "../harness-list.ts";
import { MINION_THINKING_CONFIG } from "../types.ts";
import { useHarnessList } from "../use-harness-list.tsx";
import type { MobileSessionInfo } from "./mobile-selectors.ts";
import { randomUuid } from "../random-id.ts";

interface SettingsScreenProps {
  project: {
    id: string;
    name: string;
    path: string;
  };
  sessions?: MobileSessionInfo[];
  send?: (data: unknown) => void;
  subscribe?: SocketSubscribe;
}

type SaveState = "idle" | "saving" | "saved" | "error";
type RestartState = "idle" | "pending" | "sent";
type UsageProvider = "claude" | "openai";
type UsageLoadState = "idle" | "loading" | "loaded" | "error";

interface UsageProviderState {
  state: UsageLoadState;
  sessionKey: string | null;
  usage?: unknown;
  error?: string | undefined;
}

const USAGE_PROVIDERS: ReadonlyArray<{
  id: UsageProvider;
  label: string;
  harness: string;
}> = [
  { id: "claude", label: "Claude", harness: "claude" },
  { id: "openai", label: "OpenAI", harness: "codex" },
];
const USAGE_QUERY_TIMEOUT_MS = 10_000;

function makeRequestId(provider: UsageProvider): string {
  return `mobile-usage-${provider}-${randomUuid()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function usageWindowRows(usage: unknown): Array<{ label: string; value: string; reset: string }> {
  if (!isRecord(usage) || !isRecord(usage["rate_limits"])) return [];
  const labels: Record<string, string> = {
    five_hour: "5 hour",
    seven_day: "7 day",
    seven_day_oauth_apps: "7 day OAuth apps",
    seven_day_opus: "7 day Opus",
    seven_day_sonnet: "7 day Sonnet",
  };
  return Object.entries(labels).flatMap(([key, label]) => {
    const window = usage["rate_limits"];
    if (!isRecord(window)) return [];
    const entry = window[key];
    if (!isRecord(entry)) return [];
    const utilization = typeof entry["utilization"] === "number"
      ? `${Math.round(entry["utilization"])}%`
      : "Unknown";
    const reset =
      typeof entry["resets_at"] === "string" && entry["resets_at"]
        ? new Date(entry["resets_at"]).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "Unknown";
    return [{ label, value: utilization, reset }];
  });
}

function extraUsageRow(usage: unknown): { value: string; reset: string } | null {
  if (!isRecord(usage) || !isRecord(usage["rate_limits"])) return null;
  const extra = usage["rate_limits"]["extra_usage"];
  if (!isRecord(extra) || extra["is_enabled"] !== true) return null;
  const used = typeof extra["used_credits"] === "number" ? extra["used_credits"] : null;
  const limit = typeof extra["monthly_limit"] === "number" ? extra["monthly_limit"] : null;
  const currency = typeof extra["currency"] === "string" ? extra["currency"] : "credits";
  const value = used !== null && limit !== null ? `${used}/${limit} ${currency}` : "Enabled";
  return { value, reset: "Monthly" };
}

export function SettingsScreen({ project, send, subscribe }: SettingsScreenProps) {
  const [settings, setSettings] = useState<ProjectSettings>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartState, setRestartState] = useState<RestartState>("idle");
  const [restartError, setRestartError] = useState<string | null>(null);
  const [usageReports, setUsageReports] = useState<Record<UsageProvider, UsageProviderState>>({
    claude: { state: "idle", sessionKey: null },
    openai: { state: "idle", sessionKey: null },
  });

  const { harnesses, loaded: harnessesLoaded } = useHarnessList();
  const modelGroups = useMemo(
    () => buildModelGroups(harnesses, harnessesLoaded),
    [harnesses, harnessesLoaded],
  );

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setLoadError(null);
    setSaveState("idle");
    void getProjectSettings(project.id)
      .then((result) => {
        if (cancelled) return;
        setSettings(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const saveSettings = useCallback(
    (next: ProjectSettings) => {
      setSettings(next);
      setSaveState("saving");
      void updateProjectSettings(project.id, next)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    },
    [project.id],
  );

  const requestRestart = useCallback(() => {
    setRestartState("pending");
    setRestartError(null);
    void restartServer()
      .then(() => setRestartState("sent"))
      .catch((err: unknown) => {
        setRestartState("idle");
        setRestartError(err instanceof Error ? err.message : "Failed to restart server");
      });
  }, []);

  const refreshUsage = useCallback(() => {
    if (!send || !subscribe) {
      setUsageReports({
        claude: { state: "error", sessionKey: null, error: "Usage queries need a socket connection." },
        openai: { state: "error", sessionKey: null, error: "Usage queries need a socket connection." },
      });
      return;
    }

    const pending = new Map<string, UsageProvider>();
    const nextReports = {} as Record<UsageProvider, UsageProviderState>;
    for (const provider of USAGE_PROVIDERS) {
      const requestId = makeRequestId(provider.id);
      pending.set(requestId, provider.id);
      nextReports[provider.id] = { state: "loading", sessionKey: null };
    }

    setUsageReports(nextReports);
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timeoutId = window.setTimeout(() => {
      finishPending("Usage query timed out. Restart the server if it was running before this update.");
    }, USAGE_QUERY_TIMEOUT_MS);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      unsubscribe?.();
    };

    const finishPending = (error: string) => {
      if (pending.size === 0) {
        cleanup();
        return;
      }
      const providers = [...pending.values()];
      pending.clear();
      setUsageReports((current) => {
        const next = { ...current };
        for (const provider of providers) {
          next[provider] = {
            state: "error",
            sessionKey: current[provider]?.sessionKey ?? null,
            error,
          };
        }
        return next;
      });
      cleanup();
    };

    unsubscribe = subscribe("*", (msg: ServerMessage) => {
      if (msg.type === "error" && /get_provider_usage_report|Unknown command type/.test(msg.message)) {
        finishPending(msg.message);
        return;
      }
      if (msg.type !== "control_response" || msg.command !== "get_provider_usage_report") return;
      const requestId = msg.requestId;
      if (!requestId) return;
      const provider = pending.get(requestId);
      if (!provider) return;
      pending.delete(requestId);
      setUsageReports((current) => ({
        ...current,
        [provider]: {
          state: msg.success ? "loaded" : "error",
          sessionKey: typeof msg.sessionKey === "string" ? msg.sessionKey : null,
          usage: msg.success ? msg["usage"] : undefined,
          error: msg.success ? undefined : msg.error ?? "Usage report unavailable.",
        },
      }));
      if (pending.size === 0) cleanup();
    });

    for (const provider of USAGE_PROVIDERS) {
      const requestId = [...pending.entries()].find(([, id]) => id === provider.id)?.[0];
      if (!requestId) continue;
      send({ type: "get_provider_usage_report", harness: provider.harness, requestId });
    }
  }, [send, subscribe]);

  const minionSelection = resolveModelSelection(
    settings.defaultMinionHarness ?? "claude",
    settings.defaultMinionModel ?? settings.defaultModel ?? "claude-sonnet-5",
    modelGroups,
  );
  const minionHarness = findHarness(harnesses, minionSelection.harness);
  const minionThinking = normalizeThinkingConfig(
    settings.defaultMinionThinkingConfig,
    MINION_THINKING_CONFIG,
  );
  const minionCapability = getModelCapability(minionSelection.model, minionHarness);

  return (
    <main className="mob-screen mob-settings" aria-label="Settings">
      <header className="mob-screen-header">
        <div>
          <h1>Settings</h1>
          <p className="mob-settings-project">{project.name}</p>
        </div>
        <span className="mob-settings-save" data-state={saveState}>
          {saveState === "saving"
            ? "Saving"
            : saveState === "saved"
              ? "Saved"
              : saveState === "error"
                ? "Save failed"
                : ""}
        </span>
      </header>

      {loading ? <div className="mob-launch-status">Loading settings...</div> : null}
      {loadError ? <div className="mob-launch-error" role="alert">{loadError}</div> : null}

      {!loading && !loadError ? (
        <>
          <section className="mob-settings-section" aria-labelledby="mob-default-minion-heading">
            <div className="mob-settings-section-heading">
              <h2 id="mob-default-minion-heading">Default Minion</h2>
              <p>Used when leaders delegate new Minion sessions in this project.</p>
            </div>

            <label className="mob-launch-field">
              <span>Model</span>
              <ModelSelect
                value={minionSelection.value}
                groups={modelGroups}
                onChange={(selection) =>
                  saveSettings({
                    ...settings,
                    defaultMinionHarness: selection.harness,
                    defaultMinionModel: selection.model,
                    defaultMinionThinkingConfig: normalizeThinkingForCapability(
                      minionThinking,
                      getModelCapability(selection.model, findHarness(harnesses, selection.harness)),
                    ),
                  })
                }
              />
            </label>

            <div className="mob-settings-control">
              <span>Reasoning</span>
              <ThinkingControls
                config={minionThinking}
                capability={minionCapability}
                onChange={(config) =>
                  saveSettings({
                    ...settings,
                    defaultMinionThinkingConfig: normalizeThinkingForCapability(
                      config,
                      minionCapability,
                    ),
                  })
                }
              />
            </div>
          </section>

          <section className="mob-settings-section" aria-labelledby="mob-usage-heading">
            <div className="mob-settings-section-heading mob-settings-section-heading--action">
              <div>
                <h2 id="mob-usage-heading">Usage</h2>
                <p>Current provider limit windows from the local account connection.</p>
              </div>
              <button type="button" className="mob-settings-secondary-button" onClick={refreshUsage}>
                Refresh
              </button>
            </div>

            <div className="mob-usage-grid">
              {USAGE_PROVIDERS.map((provider) => {
                const report = usageReports[provider.id];
                const rows = usageWindowRows(report.usage);
                const extra = extraUsageRow(report.usage);
                const rateLimitsAvailable =
                  isRecord(report.usage) && report.usage["rate_limits_available"] === true;
                return (
                  <div className="mob-usage-card" key={provider.id}>
                    <div className="mob-usage-card-header">
                      <strong>{provider.label}</strong>
                      <span>{report.state === "loading" ? "Loading" : report.sessionKey ?? "Provider"}</span>
                    </div>
                    {report.state === "idle" ? (
                      <p className="mob-usage-muted">Tap Refresh to query usage.</p>
                    ) : report.state === "loading" ? (
                      <p className="mob-usage-muted">Querying provider...</p>
                    ) : report.state === "error" ? (
                      <p className="mob-usage-error">{report.error}</p>
                    ) : rows.length > 0 || extra ? (
                      <dl className="mob-usage-windows">
                        {rows.map((row) => (
                          <div key={row.label}>
                            <dt>{row.label}</dt>
                            <dd>
                              <span>{row.value}</span>
                              <small>Resets {row.reset}</small>
                            </dd>
                          </div>
                        ))}
                        {extra ? (
                          <div>
                            <dt>Extra usage</dt>
                            <dd>
                              <span>{extra.value}</span>
                              <small>{extra.reset}</small>
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : (
                      <p className="mob-usage-muted">
                        {isRecord(report.usage) && typeof report.usage["unavailable_reason"] === "string"
                          ? report.usage["unavailable_reason"]
                          : rateLimitsAvailable
                            ? "No reset windows returned for this provider."
                            : "Provider limits are not available for this provider."}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mob-settings-section mob-settings-section--danger" aria-labelledby="mob-server-heading">
            <div className="mob-settings-section-heading">
              <h2 id="mob-server-heading">Server</h2>
              <p>Restart the active Minions backend to pick up newly changed code.</p>
            </div>
            <button
              type="button"
              className="mob-settings-danger-button"
              onClick={() => {
                setRestartError(null);
                setRestartDialogOpen(true);
              }}
            >
              Restart Server
            </button>
          </section>
        </>
      ) : null}

      {restartDialogOpen ? (
        <div
          className="mob-settings-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && restartState !== "pending") {
              setRestartDialogOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Restart Minions server"
            className="mob-settings-modal"
          >
            <h2>Restart Minions server?</h2>
            <p>
              {restartState === "sent"
                ? "Restart requested. The app will reconnect when the server is back."
                : "Active sessions will disconnect while the backend restarts. Use this only when you need the running server to pick up new code."}
            </p>
            {restartError ? <div className="mob-launch-error" role="alert">{restartError}</div> : null}
            <div className="mob-settings-modal-actions">
              <button
                type="button"
                onClick={() => {
                  if (restartState !== "pending") {
                    setRestartDialogOpen(false);
                    if (restartState === "sent") setRestartState("idle");
                  }
                }}
                disabled={restartState === "pending"}
              >
                {restartState === "sent" ? "Close" : "Cancel"}
              </button>
              {restartState !== "sent" ? (
                <button
                  type="button"
                  className="mob-settings-danger-button"
                  onClick={requestRestart}
                  disabled={restartState === "pending"}
                >
                  {restartState === "pending" ? "Restarting..." : "Restart Server"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
