import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { restartServer, type ProjectSettings } from "./api.ts";
import { useTheme } from "./use-theme.ts";
import { useHarnessList } from "./use-harness-list.tsx";
import { findHarness, type HarnessInfo } from "./harness-list.ts";
import type { EffortLevel, ThinkingConfig } from "./types.ts";
import { DEFAULT_THINKING_CONFIG, MINION_THINKING_CONFIG } from "./types.ts";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import { getModelCapability } from "./model-meta.ts";
import {
  DASHBOARD_LEADER_ACTIONS,
  DEFAULT_DASHBOARD_LEADER_ACTION_NAMES,
  DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS,
  type DashboardLeaderAction,
} from "./dashboard-leader-actions.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";

interface SettingsMenuProps {
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
}

type UsageProvider = "claude" | "openai";
type UsageLoadState = "idle" | "loading" | "loaded" | "error";

interface UsageProviderState {
  state: UsageLoadState;
  sessionKey: string | null;
  usage?: unknown;
  error?: string | undefined;
}

interface SystemModelStatus {
  enabled: boolean;
  mode: "off" | "advisory" | "enforced";
  manifestFound: boolean;
  loadErrors: Array<{ file?: string; message?: string }>;
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

/**
 * Header-anchored settings menu. Renders a gear button in the project
 * header; clicking opens a popover with theme + per-project preferences.
 */
export function SettingsMenu({
  settings,
  onSettingsChange,
  socketSend,
  socketSubscribe,
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Open settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 30,
          padding: 0,
          background: open ? "var(--bg-elevated)" : "transparent",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          color: "var(--text-secondary)",
          cursor: "pointer",
          transition: "background 120ms ease, border-color 120ms ease",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.borderColor = "var(--border-hover)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.borderColor = "var(--border-default)")
        }
      >
        <GearIcon />
      </button>
      {open && (
        <SettingsPopover
          settings={settings}
          onSettingsChange={onSettingsChange}
          socketSend={socketSend}
          socketSubscribe={socketSubscribe}
        />
      )}
    </div>
  );
}

// ── Popover body ────────────────────────────────────────────

function SettingsPopover({
  settings,
  onSettingsChange,
  socketSend,
  socketSubscribe,
}: {
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
}) {
  const { themeId, setTheme, themes: allThemes } = useTheme();
  const { harnesses, loaded: harnessesLoaded } = useHarnessList();
  const [restartModalOpen, setRestartModalOpen] = useState(false);
  const [restartState, setRestartState] = useState<"idle" | "pending" | "sent">("idle");
  const [restartError, setRestartError] = useState<string | null>(null);
  const [usageReports, setUsageReports] = useState<Record<UsageProvider, UsageProviderState>>({
    claude: { state: "idle", sessionKey: null },
    openai: { state: "idle", sessionKey: null },
  });
  const [systemModelStatus, setSystemModelStatus] = useState<SystemModelStatus | null>(null);
  const [systemModelStatusUnavailable, setSystemModelStatusUnavailable] = useState(false);
  const modelGroups = useMemo(
    () => buildModelGroups(harnesses, harnessesLoaded),
    [harnesses, harnessesLoaded],
  );
  const leaderSelection = resolveModelSelection(
    settings.defaultLeaderHarness ?? "claude",
    settings.defaultLeaderModel ?? settings.defaultModel ?? "claude-opus-4-8",
    modelGroups,
  );
  const minionSelection = resolveModelSelection(
    settings.defaultMinionHarness ?? "claude",
    settings.defaultMinionModel ?? settings.defaultModel ?? "claude-sonnet-5",
    modelGroups,
  );
  const leaderHarness = findHarness(harnesses, leaderSelection.harness);
  const minionHarness = findHarness(harnesses, minionSelection.harness);
  const leaderThinking = normalizeThinkingConfig(
    settings.defaultLeaderThinkingConfig,
    DEFAULT_THINKING_CONFIG,
  );
  const minionThinking = normalizeThinkingConfig(
    settings.defaultMinionThinkingConfig,
    MINION_THINKING_CONFIG,
  );
  const leaderCapability = getModelCapability(leaderSelection.model, leaderHarness);
  const minionCapability = getModelCapability(minionSelection.model, minionHarness);

  useEffect(() => {
    if (settings.systemModel === undefined || settings.systemModel === "off") {
      setSystemModelStatus(null);
      setSystemModelStatusUnavailable(false);
      return;
    }
    if (!socketSend || !socketSubscribe) {
      setSystemModelStatusUnavailable(true);
      return;
    }

    const requestId = `system-model-status-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let statusRequested = false;
    const unsubscribe = socketSubscribe("*", (msg: ServerMessage) => {
      if (msg.type === "session_list" && !statusRequested) {
        const session = msg.sessions.find((item) => item.role === "leader") ?? msg.sessions[0];
        if (!session) {
          setSystemModelStatusUnavailable(true);
          return;
        }
        statusRequested = true;
        socketSend({
          type: "get_system_model_status",
          sessionKey: session.sessionKey,
          requestId,
        });
        return;
      }
      if (
        msg.type !== "control_response"
        || msg.command !== "get_system_model_status"
        || msg.requestId !== requestId
      ) return;

      const status = msg["status"];
      if (!msg.success || !isSystemModelStatus(status)) {
        setSystemModelStatusUnavailable(true);
        return;
      }
      setSystemModelStatus(status);
      setSystemModelStatusUnavailable(false);
    });

    socketSend({ type: "list_sessions" });
    return unsubscribe;
  }, [settings.systemModel, socketSend, socketSubscribe]);

  const requestRestart = async () => {
    setRestartState("pending");
    setRestartError(null);
    try {
      await restartServer();
      setRestartState("sent");
    } catch (err) {
      setRestartState("idle");
      setRestartError(err instanceof Error ? err.message : String(err));
    }
  };

  const refreshUsage = useCallback(() => {
    if (!socketSend || !socketSubscribe) {
      setUsageReports({
        claude: {
          state: "error",
          sessionKey: null,
          error: "Usage queries need a socket connection.",
        },
        openai: {
          state: "error",
          sessionKey: null,
          error: "Usage queries need a socket connection.",
        },
      });
      return;
    }

    const pending = new Map<string, UsageProvider>();
    const nextReports = {} as Record<UsageProvider, UsageProviderState>;
    for (const provider of USAGE_PROVIDERS) {
      const requestId = makeUsageRequestId(provider.id);
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

    unsubscribe = socketSubscribe("*", (msg: ServerMessage) => {
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
      socketSend({
        type: "get_provider_usage_report",
        harness: provider.harness,
        requestId,
      });
    }
  }, [socketSend, socketSubscribe]);

  return (
    <>
      <div
        role="dialog"
        aria-label="Settings"
        style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          right: 0,
          width: 320,
          maxHeight: "calc(100vh - 80px)",
          overflowY: "auto",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          boxShadow: "var(--shadow-lg)",
          padding: "14px 14px 16px",
          zIndex: 250,
        }}
      >
      <div
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 10,
        }}
      >
        Settings
      </div>

      {/* ── Theme ── */}
      <FieldLabel>Theme</FieldLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          marginBottom: 16,
        }}
      >
        {allThemes.map((t) => {
          const isActive = t.id === themeId;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              title={t.description}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 9px",
                background: isActive ? "var(--bg-elevated)" : "transparent",
                border: isActive
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border-default)",
                borderRadius: 6,
                cursor: "pointer",
                transition: "border-color 120ms ease, background 120ms ease",
                outline: "none",
                textAlign: "left",
              }}
              onMouseEnter={(e) => {
                if (!isActive)
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--border-hover)";
              }}
              onMouseLeave={(e) => {
                if (!isActive)
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--border-default)";
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  background: t.swatch.bg,
                  border: `2px solid ${t.swatch.accent}`,
                  flexShrink: 0,
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    bottom: 1,
                    right: 1,
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: t.swatch.accent,
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-sans)",
                  color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                  fontWeight: isActive ? 600 : 400,
                  lineHeight: 1.2,
                }}
              >
                {t.name}
              </span>
            </button>
          );
        })}
      </div>

      <Divider />

      {/* ── Default Permission Mode ── */}
      <FieldLabel>Default Permission Mode</FieldLabel>
      <Select
        value={settings.defaultPermissionMode ?? "auto"}
        onChange={(v) =>
          onSettingsChange({ ...settings, defaultPermissionMode: v })
        }
        options={[
          { value: "auto", label: "Auto (Safe Approve)" },
          { value: "bypassPermissions", label: "Bypass Permissions" },
          { value: "default", label: "Default (Ask)" },
        ]}
      />
      <Spacer />

      {/* ── Default Leader Model ── */}
      <FieldLabel>Default Leader Model</FieldLabel>
      <ModelSelect
        value={leaderSelection.value}
        groups={modelGroups}
        onChange={(selection) =>
          onSettingsChange({
            ...settings,
            defaultModel: selection.model,
            defaultLeaderHarness: selection.harness,
            defaultLeaderModel: selection.model,
            defaultLeaderThinkingConfig: normalizeThinkingForCapability(
              leaderThinking,
              getModelCapability(selection.model, findHarness(harnesses, selection.harness)),
            ),
          })
        }
      />
      <ThinkingControls
        config={leaderThinking}
        capability={leaderCapability}
        onChange={(config) =>
          onSettingsChange({
            ...settings,
            defaultLeaderThinkingConfig: normalizeThinkingForCapability(
              config,
              leaderCapability,
            ),
          })
        }
      />
      <FieldHint>Harness, model, and reasoning used when spawning new Leader nodes</FieldHint>

      {/* ── Default Minion Model ── */}
      <FieldLabel>Default Minion Model</FieldLabel>
      <ModelSelect
        value={minionSelection.value}
        groups={modelGroups}
        onChange={(selection) =>
          onSettingsChange({
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
      <ThinkingControls
        config={minionThinking}
        capability={minionCapability}
        onChange={(config) =>
          onSettingsChange({
            ...settings,
            defaultMinionThinkingConfig: normalizeThinkingForCapability(
              config,
              minionCapability,
            ),
          })
        }
      />
      <FieldHint>Harness, model, and reasoning used when spawning new Minion nodes</FieldHint>

      <Divider />

      {/* ── Worktree Isolation ── */}
      <FieldLabel>Default Worktree Isolation</FieldLabel>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
        }}
      >
        <input
          type="checkbox"
          checked={settings.defaultWorktreeIsolation !== false}
          onChange={(e) =>
            onSettingsChange({
              ...settings,
              defaultWorktreeIsolation: e.target.checked,
            })
          }
          style={{ cursor: "pointer" }}
        />
        Enable for new Leader nodes
      </label>
      <FieldHint>
        Leaders work in an isolated git worktree branch with approval-based
        merging
      </FieldHint>

      <Divider />

      {/* ── Tidy Layout ── */}
      <FieldLabel>Canvas Layout</FieldLabel>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
        }}
      >
        <input
          type="checkbox"
          checked={settings.tidyLayout !== false}
          onChange={(e) =>
            onSettingsChange({
              ...settings,
              tidyLayout: e.target.checked,
            })
          }
          style={{ cursor: "pointer" }}
        />
        Tidy layout (snap to grid, prevent overlaps)
      </label>
      <FieldHint>
        Overlapping nodes snap flush against their neighbour on the side
        nearest where you drop them. Dashboards stay affixed to their leader.
      </FieldHint>

      <Divider />

      {/* ── System Model ── */}
      <FieldLabel>System Model</FieldLabel>
      <Select
        value={settings.systemModel ?? "off"}
        onChange={(v) =>
          onSettingsChange({
            ...settings,
            systemModel: v as NonNullable<ProjectSettings["systemModel"]>,
          })
        }
        options={[
          { value: "off", label: "Off" },
          { value: "advisory", label: "Advisory (Context Only)" },
          { value: "enforced", label: "Enforced (Blocks Merges)" },
        ]}
      />
      <FieldHint>
        Compiles the repo's <code>.systemmodel/</code> into Context Packs for
        minions. Enforced blocks merges that fail review gates. Requires a{" "}
        <code>.systemmodel/manifest.yaml</code> in the worktree.
      </FieldHint>
      {settings.systemModel !== undefined
        && settings.systemModel !== "off"
        && (systemModelStatus?.manifestFound === false || systemModelStatusUnavailable) && (
          <div
            role="status"
            style={{
              marginTop: -8,
              marginBottom: 12,
              color: "var(--warning-color, var(--text-secondary))",
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              lineHeight: 1.4,
            }}
          >
            {systemModelStatus?.manifestFound === false
              ? <>System model is enabled but inactive. Seed <code>.systemmodel/manifest.yaml</code></>
              : <>For a new system model, seed <code>.systemmodel/manifest.yaml</code></>}{" "}
            using <a href="docs/system-model.md">the system model guide</a>.
          </div>
        )}

      <Divider />

      <UsageReportSection reports={usageReports} onRefresh={refreshUsage} />

      <Divider />

      {/* ── Dashboard Context Actions ── */}
      <FieldLabel>Dashboard Context Prompts</FieldLabel>
      {DASHBOARD_LEADER_ACTIONS.map(({ action }) => (
        <DashboardActionField
          key={action}
          name={dashboardActionNameValue(settings, action)}
          prompt={dashboardPromptValue(settings, action)}
          onNameChange={(value) =>
            onSettingsChange({
              ...settings,
              dashboardLeaderActionNames: {
                ...settings.dashboardLeaderActionNames,
                [action]: value,
              },
            })
          }
          onPromptChange={(value) =>
            onSettingsChange({
              ...settings,
              dashboardLeaderActionPrompts: {
                ...settings.dashboardLeaderActionPrompts,
                [action]: value,
              },
            })
          }
        />
      ))}
      <FieldHint>
        Used when dropping dashboard context onto the canvas and choosing an
        action
      </FieldHint>

        <Divider />

        <FieldLabel>Server</FieldLabel>
        <button
          type="button"
          onClick={() => {
            setRestartError(null);
            setRestartModalOpen(true);
          }}
          style={{
            width: "100%",
            padding: "7px 10px",
            borderRadius: 6,
            border: "1px solid var(--danger-color)",
            background: "transparent",
            color: "var(--danger-color)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          Restart Server
        </button>
        <FieldHint>Restarts the active Minions backend to pick up new code</FieldHint>
        {restartError && (
          <div
            role="alert"
            style={{
              marginTop: -8,
              marginBottom: 12,
              color: "var(--danger-color)",
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              lineHeight: 1.4,
            }}
          >
            {restartError}
          </div>
        )}
      </div>

      {restartModalOpen && (
        <ConfirmModal
          title="Restart Minions server?"
          description={
            restartState === "sent"
              ? "Restart requested. The app will reconnect when the server is back."
              : "Active sessions will disconnect while the backend restarts. Use this only when you need the running server to pick up newly changed code."
          }
          onClose={() => {
            if (restartState !== "pending") {
              setRestartModalOpen(false);
              if (restartState === "sent") setRestartState("idle");
            }
          }}
          actions={
            restartState === "sent"
              ? [
                  {
                    label: "Close",
                    variant: "primary",
                    onClick: () => {
                      setRestartModalOpen(false);
                      setRestartState("idle");
                    },
                  },
                ]
              : [
                  {
                    label: restartState === "pending" ? "Restarting..." : "Restart Server",
                    variant: "danger",
                    onClick: () => {
                      if (restartState === "idle") void requestRestart();
                    },
                  },
                ]
          }
        />
      )}
    </>
  );
}

function isSystemModelStatus(value: unknown): value is SystemModelStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return typeof status["enabled"] === "boolean"
    && (status["mode"] === "off" || status["mode"] === "advisory" || status["mode"] === "enforced")
    && typeof status["manifestFound"] === "boolean"
    && Array.isArray(status["loadErrors"]);
}

function UsageReportSection({
  reports,
  onRefresh,
}: {
  reports: Record<UsageProvider, UsageProviderState>;
  onRefresh: () => void;
}) {
  return (
    <section aria-labelledby="desktop-usage-heading">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 8,
        }}
      >
        <FieldLabel id="desktop-usage-heading">Usage</FieldLabel>
        <button
          type="button"
          onClick={onRefresh}
          style={{
            padding: "4px 8px",
            borderRadius: 5,
            border: "1px solid var(--border-default)",
            background: "var(--bg-primary)",
            color: "var(--text-secondary)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {USAGE_PROVIDERS.map((provider) => (
          <UsageProviderReport
            key={provider.id}
            label={provider.label}
            report={reports[provider.id]}
          />
        ))}
      </div>
    </section>
  );
}

function UsageProviderReport({
  label,
  report,
}: {
  label: string;
  report: UsageProviderState;
}) {
  const rows = usageWindowRows(report.usage);
  const extra = extraUsageRow(report.usage);
  const unavailableReason = usageUnavailableReason(report.usage);
  const rateLimitsAvailable =
    isRecord(report.usage) && report.usage["rate_limits_available"] === true;

  return (
    <div
      style={{
        padding: "8px 9px",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        background: "var(--bg-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <strong
          style={{
            fontSize: 12,
            color: "var(--text-primary)",
            fontFamily: "var(--font-sans)",
          }}
        >
          {label}
        </strong>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {report.state === "loading" ? "Loading" : report.sessionKey ?? "Provider"}
        </span>
      </div>

      {report.state === "idle" ? (
        <UsageText>Refresh to query provider usage.</UsageText>
      ) : report.state === "loading" ? (
        <UsageText>Querying provider...</UsageText>
      ) : report.state === "error" ? (
        <UsageText tone="error">{report.error}</UsageText>
      ) : rows.length > 0 || extra ? (
        <dl style={{ display: "grid", gap: 5, margin: 0 }}>
          {rows.map((row) => (
            <UsageWindowRow key={row.label} row={row} />
          ))}
          {extra ? (
            <UsageWindowRow
              row={{ label: "Extra usage", value: extra.value, reset: extra.reset }}
            />
          ) : null}
        </dl>
      ) : (
        <UsageText>
          {unavailableReason ??
            (rateLimitsAvailable
              ? "No reset windows returned for this provider."
              : "Provider limits are not available for this provider.")}
        </UsageText>
      )}
    </div>
  );
}

function UsageWindowRow({
  row,
}: {
  row: { label: string; value: string; reset: string };
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 8,
        alignItems: "baseline",
      }}
    >
      <dt
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          fontFamily: "var(--font-sans)",
        }}
      >
        {row.label}
      </dt>
      <dd
        style={{
          margin: 0,
          textAlign: "right",
          fontSize: 11,
          color: "var(--text-primary)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{row.value}</span>
        <small
          style={{
            display: "block",
            color: "var(--text-muted)",
            fontSize: 10,
            marginTop: 1,
          }}
        >
          Resets {row.reset}
        </small>
      </dd>
    </div>
  );
}

function UsageText({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <p
      style={{
        margin: 0,
        color: tone === "error" ? "var(--danger-color)" : "var(--text-muted)",
        fontSize: 11,
        lineHeight: 1.4,
        fontFamily: "var(--font-sans)",
      }}
    >
      {children}
    </p>
  );
}

function makeUsageRequestId(provider: UsageProvider): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `desktop-usage-${provider}-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function usageWindowRows(usage: unknown): Array<{ label: string; value: string; reset: string }> {
  if (!isRecord(usage) || !isRecord(usage["rate_limits"])) return [];
  const windows = usage["rate_limits"];
  const labels: Record<string, string> = {
    five_hour: "5 hour",
    seven_day: "7 day",
    seven_day_oauth_apps: "7 day OAuth apps",
    seven_day_opus: "7 day Opus",
    seven_day_sonnet: "7 day Sonnet",
  };
  return Object.entries(labels).flatMap(([key, label]) => {
    if (!isRecord(windows)) return [];
    const entry = windows[key];
    if (!isRecord(entry)) return [];
    const utilization =
      typeof entry["utilization"] === "number"
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

function usageUnavailableReason(usage: unknown): string | null {
  if (!isRecord(usage)) return null;
  return typeof usage["unavailable_reason"] === "string" ? usage["unavailable_reason"] : null;
}

function dashboardActionNameValue(
  settings: ProjectSettings,
  action: DashboardLeaderAction,
): string {
  const configured = settings.dashboardLeaderActionNames?.[action];
  return typeof configured === "string"
    ? configured
    : DEFAULT_DASHBOARD_LEADER_ACTION_NAMES[action];
}

function dashboardPromptValue(
  settings: ProjectSettings,
  action: DashboardLeaderAction,
): string {
  const configured = settings.dashboardLeaderActionPrompts?.[action];
  return typeof configured === "string"
    ? configured
    : DEFAULT_DASHBOARD_LEADER_ACTION_PROMPTS[action];
}

// ── Model settings helpers ─────────────────────────────────

export interface ModelGroup {
  harness: string;
  label: string;
  options: Array<{ value: string; label: string; model: string; harness: string }>;
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Fastest; minimal reasoning when possible",
  medium: "Moderate reasoning for typical delegated work",
  high: "Deep reasoning default for complex work",
  xhigh: "Extra reasoning for supported models",
  max: "Maximum reasoning for supported models",
};

const FALLBACK_MODEL_GROUPS: ModelGroup[] = [
  {
    harness: "claude",
    label: "Anthropic",
    options: [
      {
        value: "claude::claude-fable-5",
        label: "Fable 5",
        model: "claude-fable-5",
        harness: "claude",
      },
      {
        value: "claude::claude-opus-4-8",
        label: "Opus 4.8",
        model: "claude-opus-4-8",
        harness: "claude",
      },
      {
        value: "claude::claude-opus-4-7",
        label: "Opus 4.7",
        model: "claude-opus-4-7",
        harness: "claude",
      },
      {
        value: "claude::claude-sonnet-5",
        label: "Sonnet 5",
        model: "claude-sonnet-5",
        harness: "claude",
      },
      {
        value: "claude::claude-haiku-4-5",
        label: "Haiku 4.5",
        model: "claude-haiku-4-5",
        harness: "claude",
      },
    ],
  },
];

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-4-8",
  "opus-old": "claude-opus-4-7",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  "gpt-5": "gpt-5.6-sol",
  "gpt-5-codex": "gpt-5.6-sol",
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-5.5": "gpt-5.6-sol",
  "gpt-5.4": "gpt-5.6-terra",
  "gpt-5.3-codex-spark": "gpt-5.6-luna",
};

export function buildModelGroups(
  harnesses: ReadonlyArray<HarnessInfo>,
  loaded: boolean,
): ModelGroup[] {
  if (!loaded || harnesses.length === 0) return FALLBACK_MODEL_GROUPS;
  return harnesses
    .filter((h) => h.models.length > 0)
    .map((h) => {
      const label = providerLabel(h);
      return {
        harness: h.name,
        label,
        options: h.models.map((m) => ({
          value: `${h.name}::${m.id}`,
          label: `${m.label} (${label})`,
          model: m.id,
          harness: h.name,
        })),
      };
    });
}

function providerLabel(harness: HarnessInfo): string {
  const provider = String(harness.account.provider ?? harness.name).toLowerCase();
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic" || provider === "claude") return "Anthropic";
  if (provider === "echo") return "Echo";
  return harness.name.charAt(0).toUpperCase() + harness.name.slice(1);
}

export function resolveModelSelection(
  preferredHarness: string,
  model: string,
  groups: ModelGroup[],
): { value: string; harness: string; model: string } {
  const canonicalModel = LEGACY_MODEL_ALIASES[model] ?? model;
  const exact = findModelOption(groups, preferredHarness, canonicalModel);
  if (exact) return exact;

  const anyHarnessExact = groups
    .flatMap((g) => g.options)
    .find((o) => o.model === canonicalModel);
  if (anyHarnessExact) return anyHarnessExact;

  const preferredDefault = groups.find((g) => g.harness === preferredHarness)?.options[0];
  const fallback = preferredDefault ?? groups[0]?.options[0] ?? FALLBACK_MODEL_GROUPS[0]!.options[0]!;
  return fallback;
}

function findModelOption(
  groups: ModelGroup[],
  harness: string,
  model: string,
): { value: string; harness: string; model: string } | undefined {
  return groups
    .find((g) => g.harness === harness)
    ?.options.find((o) => o.model === model);
}

export function normalizeThinkingConfig(
  value: unknown,
  fallback: ThinkingConfig,
): ThinkingConfig {
  if (typeof value !== "object" || value === null) return { ...fallback };
  const cfg = value as Partial<Record<keyof ThinkingConfig, unknown>>;
  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : fallback.enabled;
  const effort = isEffortLevel(cfg.effort) ? cfg.effort : fallback.effort;
  const display =
    cfg.display === "summarized" || cfg.display === "omitted"
      ? cfg.display
      : fallback.display;
  return { enabled, effort, display };
}

export function normalizeThinkingForCapability(
  config: ThinkingConfig,
  capability: ReturnType<typeof getModelCapability>,
): ThinkingConfig {
  if (!capability.supportsAdaptiveThinking) return { ...config, enabled: false };
  if (capability.supportedEffortLevels.includes(config.effort)) return { ...config };
  return {
    ...config,
    effort: capability.supportedEffortLevels.includes("high")
      ? "high"
      : (capability.supportedEffortLevels[0] ?? config.effort),
  };
}

function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

// ── Small layout helpers ────────────────────────────────────

function FieldLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <label
      id={id}
      style={{
        display: "block",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 6,
      }}
    >
      {children}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--text-muted)",
        marginTop: 4,
        marginBottom: 14,
        fontFamily: "var(--font-sans)",
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "var(--border-default)",
        margin: "4px 0 14px",
      }}
    />
  );
}

function Spacer() {
  return <div style={{ height: 14 }} />;
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        fontSize: 12,
        color: "var(--text-secondary)",
        padding: "6px 10px",
        background: "var(--bg-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        cursor: "pointer",
        outline: "none",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function DashboardActionField({
  name,
  prompt,
  onNameChange,
  onPromptChange,
}: {
  name: string;
  prompt: string;
  onNameChange: (value: string) => void;
  onPromptChange: (value: string) => void;
}) {
  return (
    <div
      style={{
        marginBottom: 10,
      }}
    >
      <label
        style={{
          display: "block",
          fontSize: 10,
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          marginBottom: 4,
        }}
      >
        Name
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          style={{
            width: "100%",
            marginTop: 4,
            fontSize: 12,
            lineHeight: 1.35,
            color: "var(--text-primary)",
            padding: "6px 8px",
            background: "var(--bg-primary)",
            border: "1px solid var(--border-primary)",
            borderRadius: 4,
            fontFamily: "var(--font-sans)",
            outline: "none",
          }}
        />
      </label>
      <label
        style={{
          display: "block",
          fontSize: 10,
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
        }}
      >
        Prompt
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            marginTop: 4,
            resize: "vertical",
            minHeight: 64,
            fontSize: 11,
            lineHeight: 1.35,
            color: "var(--text-secondary)",
            padding: "7px 8px",
            background: "var(--bg-primary)",
            border: "1px solid var(--border-primary)",
            borderRadius: 4,
            fontFamily: "var(--font-sans)",
            outline: "none",
          }}
        />
      </label>
    </div>
  );
}

export function ModelSelect({
  value,
  groups,
  onChange,
}: {
  value: string;
  groups: ModelGroup[];
  onChange: (selection: { harness: string; model: string }) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => {
        const option = groups
          .flatMap((g) => g.options)
          .find((o) => o.value === e.target.value);
        if (option) onChange({ harness: option.harness, model: option.model });
      }}
      style={{
        width: "100%",
        fontSize: 12,
        color: "var(--text-secondary)",
        padding: "6px 10px",
        background: "var(--bg-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        cursor: "pointer",
        outline: "none",
      }}
    >
      {groups.map((group) => (
        <optgroup key={group.harness} label={group.label}>
          {group.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function ThinkingControls({
  config,
  capability,
  onChange,
}: {
  config: ThinkingConfig;
  capability: ReturnType<typeof getModelCapability>;
  onChange: (config: ThinkingConfig) => void;
}) {
  if (!capability.supportsAdaptiveThinking) {
    return (
      <div
        style={{
          marginTop: 7,
          padding: "7px 8px",
          border: "1px solid var(--border-default)",
          borderRadius: 4,
          color: "var(--text-muted)",
          background: "var(--bg-primary)",
          fontSize: 10,
          fontFamily: "var(--font-sans)",
        }}
      >
        Reasoning controls are unavailable for this model.
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 7,
        padding: 8,
        border: "1px solid var(--border-default)",
        borderRadius: 4,
        background: "var(--bg-primary)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        <span>Reasoning</span>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
          style={{ cursor: "pointer" }}
        />
      </label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {capability.supportedEffortLevels.map((effort) => {
          const active = config.effort === effort;
          return (
            <button
              key={effort}
              type="button"
              title={EFFORT_DESCRIPTIONS[effort]}
              disabled={!config.enabled}
              onClick={() => onChange({ ...config, effort })}
              style={{
                padding: "4px 7px",
                borderRadius: 4,
                border: active
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border-default)",
                background: active ? "var(--state-active)" : "var(--bg-secondary)",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                opacity: config.enabled ? 1 : 0.55,
                cursor: config.enabled ? "pointer" : "default",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
              }}
            >
              {EFFORT_LABELS[effort]}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        {(["summarized", "omitted"] as const).map((display) => {
          const active = config.display === display;
          return (
            <button
              key={display}
              type="button"
              disabled={!config.enabled}
              onClick={() => onChange({ ...config, display })}
              style={{
                padding: "4px 7px",
                borderRadius: 4,
                border: active
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border-default)",
                background: active ? "var(--state-active)" : "var(--bg-secondary)",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                opacity: config.enabled ? 1 : 0.55,
                cursor: config.enabled ? "pointer" : "default",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
              }}
            >
              {display === "summarized" ? "Summaries" : "Hidden"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Icon ────────────────────────────────────────────────────

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M13 8c0 .42-.04.83-.13 1.22l1.43 1.1-1.5 2.6-1.7-.6c-.6.5-1.3.9-2.05 1.13L8.8 15h-1.6l-.25-1.55c-.75-.23-1.45-.62-2.05-1.13l-1.7.6-1.5-2.6 1.43-1.1A6 6 0 013 8c0-.42.04-.83.13-1.22L1.7 5.68l1.5-2.6 1.7.6c.6-.5 1.3-.9 2.05-1.13L7.2 1h1.6l.25 1.55c.75.23 1.45.62 2.05 1.13l1.7-.6 1.5 2.6-1.43 1.1c.09.4.13.8.13 1.22z" />
    </svg>
  );
}
