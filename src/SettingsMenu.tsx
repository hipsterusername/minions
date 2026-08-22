import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectSettings } from "./api.ts";
import { useTheme } from "./use-theme.ts";
import { useHarnessList } from "./use-harness-list.tsx";
import { findHarness, type HarnessInfo } from "./harness-list.ts";
import type { EffortLevel, ThinkingConfig } from "./types.ts";
import { DEFAULT_THINKING_CONFIG, MINION_THINKING_CONFIG } from "./types.ts";
import { getModelCapability } from "./model-meta.ts";
import {
  ContextActionsSettings as ContextActionsRecipeSettings,
  type SettingsSaveState,
} from "./ContextActionsSettings.tsx";
import {
  DASHBOARD_ACTION_ICONS,
  DEFAULT_DASHBOARD_ACTION_ICON,
  dashboardActionIcon,
  defaultDashboardLeaderActions,
  normalizeDashboardLeaderActions,
  type DashboardLeaderActionConfig,
} from "./dashboard-leader-actions.ts";
import { randomUuid } from "./random-id.ts";
import type { ServerMessage, SocketSubscribe } from "./use-socket.ts";
import {
  DEFAULT_SANDBOX_POLICY,
  SandboxPolicyControls,
} from "./nodes/leader/SandboxPolicyControls.tsx";
import { ModelSelectionMenu } from "./components/SessionToolbar.tsx";
import {
  MinionModelRoutingSettings,
  type MinionTier,
} from "./MinionModelRoutingSettings.tsx";
import { AgentRoleSettings, ToggleRow } from "./SettingsControls.tsx";
import {
  Bot,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  LayoutGrid,
  MessageSquareText,
  Palette,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import "./settings-menu.css";
import { normalizeLeaderPlanningBackend } from "../shared/leader-planning.ts";

interface SettingsMenuProps {
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
  settingsSaveState?: SettingsSaveState | undefined;
  onRetrySettingsSave?: (() => void) | undefined;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
}

type SettingsCategory =
  | "general"
  | "agents"
  | "workspace"
  | "actions"
  | "governance";

interface SystemModelStatus {
  enabled: boolean;
  mode: "off" | "advisory" | "enforced";
  manifestFound: boolean;
  loadErrors: Array<{ file?: string; message?: string }>;
}

const SETTINGS_CATEGORIES: ReadonlyArray<{
  id: SettingsCategory;
  label: string;
  description: string;
  icon: typeof Palette;
  section: "project" | "labs";
  beta?: boolean;
}> = [
  {
    id: "general",
    label: "General",
    description: "Look and feel",
    icon: Palette,
    section: "project",
  },
  {
    id: "agents",
    label: "Agent defaults",
    description: "Models and access",
    icon: Bot,
    section: "project",
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Canvas behavior",
    icon: LayoutGrid,
    section: "project",
  },
  {
    id: "actions",
    label: "Context actions",
    description: "Dashboard prompts",
    icon: MessageSquareText,
    section: "labs",
    beta: true,
  },
  {
    id: "governance",
    label: "Governance",
    description: "System model",
    icon: ShieldCheck,
    section: "labs",
    beta: true,
  },
];

/**
 * Header-anchored settings menu. Renders a gear button in the project
 * header; clicking opens a popover with theme + per-project preferences.
 */
export function SettingsMenu({
  settings,
  onSettingsChange,
  settingsSaveState,
  onRetrySettingsSave,
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
          settingsSaveState={settingsSaveState}
          onRetrySettingsSave={onRetrySettingsSave}
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
  settingsSaveState,
  onRetrySettingsSave,
  socketSend,
  socketSubscribe,
}: {
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
  settingsSaveState?: SettingsSaveState | undefined;
  onRetrySettingsSave?: (() => void) | undefined;
  socketSend?: ((data: unknown) => void) | undefined;
  socketSubscribe?: SocketSubscribe | undefined;
}) {
  const { themeId, setTheme, themes: allThemes } = useTheme();
  const { harnesses, loaded: harnessesLoaded } = useHarnessList();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  const [systemModelStatus, setSystemModelStatus] = useState<SystemModelStatus | null>(null);
  const [systemModelStatusUnavailable, setSystemModelStatusUnavailable] = useState(false);
  const modelGroups = useMemo(
    () => buildModelGroups(harnesses, harnessesLoaded),
    [harnesses, harnessesLoaded],
  );
  const modelMenuHarnesses = useMemo(
    () => harnesses.filter((harness) => harness.models.length > 0),
    [harnesses],
  );
  const modelLabels = useMemo(
    () => Object.fromEntries(
      modelGroups.flatMap((group) =>
        group.options.map((option) => [
          option.model,
          option.label.replace(` (${group.label})`, ""),
        ]),
      ),
    ),
    [modelGroups],
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
  const minionTierGroups = modelGroups.filter(
    (group) => group.harness === minionSelection.harness,
  );
  const minionTierSelections = {
    mechanical: resolveModelSelection(
      minionSelection.harness,
      settings.mechanicalMinionModel ?? minionSelection.model,
      minionTierGroups,
    ),
    standard: minionSelection,
    reasoning: resolveModelSelection(
      minionSelection.harness,
      settings.reasoningMinionModel ?? minionSelection.model,
      minionTierGroups,
    ),
  };
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

  const changeMinionTierModel = (tier: MinionTier, model: string) => {
    const next: ProjectSettings = { ...settings };
    if (tier === "mechanical") next.mechanicalMinionModel = model;
    if (tier === "standard") {
      next.defaultMinionModel = model;
      next.defaultMinionThinkingConfig = normalizeThinkingForCapability(
        minionThinking,
        getModelCapability(model, minionHarness),
      );
    }
    if (tier === "reasoning") next.reasoningMinionModel = model;
    onSettingsChange(next);
  };

  const changeMinionHarness = (harness: string, model?: string) => {
    if (!model) return;
    onSettingsChange({
      ...settings,
      defaultMinionHarness: harness,
      defaultMinionModel: model,
      mechanicalMinionModel: model,
      reasoningMinionModel: model,
      defaultMinionThinkingConfig: normalizeThinkingForCapability(
        minionThinking,
        getModelCapability(model, findHarness(harnesses, harness)),
      ),
    });
  };

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

  return (
    <div
        role="dialog"
        aria-label="Settings"
        className="settings-dialog"
      >
        <aside className="settings-sidebar">
          <div className="settings-sidebar__heading">
            <span>Project</span>
            <strong>Settings</strong>
          </div>
          <nav aria-label="Settings categories" className="settings-nav">
            {(["project", "labs"] as const).map((section) => (
              <div className="settings-nav__group" key={section}>
                <span className="settings-nav__group-label">
                  {section === "project" ? "Project" : "Labs"}
                </span>
                {SETTINGS_CATEGORIES
                  .filter((category) => category.section === section)
                  .map((category) => {
                    const Icon = category.icon;
                    const selected = activeCategory === category.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        className="settings-nav__item"
                        onClick={() => setActiveCategory(category.id)}
                      >
                        <Icon size={16} aria-hidden="true" />
                        <span>
                          <strong>
                            {category.label}
                            {category.beta && <BetaBadge />}
                          </strong>
                          <small>{category.description}</small>
                        </span>
                        <ChevronRight
                          className="settings-nav__chevron"
                          size={14}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
              </div>
            ))}
          </nav>
          <p className="settings-sidebar__note">Changes save automatically for this project.</p>
        </aside>

        <main className="settings-content">
          {activeCategory === "general" && (
            <>
              <SettingsHeading
                eyebrow="Personalize"
                title="General"
                description="Choose how Minions looks while you work."
              />
              <SettingsCard
                title="Appearance"
                description="Theme applies immediately across the application."
              >
                <div
                  className="settings-theme-grid"
                  role="group"
                  aria-label="Application themes, dark themes left and light themes right"
                >
                  <span className="settings-theme-grid__heading">Dark</span>
                  <span className="settings-theme-grid__heading">Light</span>
                  {allThemes.map((theme) => {
                    const isActive = theme.id === themeId;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        aria-pressed={isActive}
                        className="settings-theme"
                        data-tone={theme.tone}
                        onClick={() => setTheme(theme.id)}
                        title={theme.description}
                      >
                        <span
                          className="settings-theme__swatch"
                          style={{ background: theme.swatch.bg, borderColor: theme.swatch.accent }}
                        >
                          <span style={{ background: theme.swatch.accent }} />
                        </span>
                        <span>
                          <strong>{theme.name}</strong>
                          <small>{theme.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </SettingsCard>
            </>
          )}

          {activeCategory === "agents" && (
            <>
              <SettingsHeading
                eyebrow="New sessions"
                title="Agent defaults"
                description="Choose the access policy and role defaults used when new sessions start."
              />
              <SettingsCard
                title="Session policy"
                description="Shared by new Leader and Minion sessions."
              >
                <FieldLabel>Default permission mode</FieldLabel>
                <Select
                  value={settings.defaultPermissionMode ?? "auto"}
                  onChange={(value) =>
                    onSettingsChange({ ...settings, defaultPermissionMode: value })
                  }
                  options={[
                    { value: "auto", label: "Auto (Safe Approve)" },
                    { value: "bypassPermissions", label: "Bypass Permissions" },
                    { value: "default", label: "Default (Ask)" },
                  ]}
                />
              </SettingsCard>

              <SettingsCard
                title="Role defaults"
                description="Set how each role starts. Changes apply to new sessions."
              >
                <div className="settings-agent-list">
                  <AgentRoleSettings
                    role="Leader"
                    description="Plans work, delegates tasks, and owns the outcome."
                  >
                    <ModelSelectionMenu
                      model={leaderSelection.model}
                      activeHarnessName={leaderSelection.harness}
                      activeHarness={leaderHarness}
                      harnesses={modelMenuHarnesses}
                      modelOptions={modelGroups
                        .find((group) => group.harness === leaderSelection.harness)
                        ?.options.map((option) => option.model) ?? []}
                      modelLabels={modelLabels}
                      capability={leaderCapability}
                      thinkingConfig={leaderThinking}
                      onModelChange={(model) =>
                        onSettingsChange({
                          ...settings,
                          defaultModel: model,
                          defaultLeaderHarness: leaderSelection.harness,
                          defaultLeaderModel: model,
                          defaultLeaderThinkingConfig: normalizeThinkingForCapability(
                            leaderThinking,
                            getModelCapability(model, leaderHarness),
                          ),
                        })
                      }
                      onHarnessChange={(harness, model) => {
                        if (!model) return;
                        onSettingsChange({
                          ...settings,
                          defaultModel: model,
                          defaultLeaderHarness: harness,
                          defaultLeaderModel: model,
                          defaultLeaderThinkingConfig: normalizeThinkingForCapability(
                            leaderThinking,
                            getModelCapability(model, findHarness(harnesses, harness)),
                          ),
                        });
                      }}
                      onThinkingConfigChange={(config) =>
                        onSettingsChange({
                          ...settings,
                          defaultLeaderThinkingConfig: normalizeThinkingForCapability(
                            config,
                            leaderCapability,
                          ),
                        })
                      }
                      hasSession={false}
                      expanded
                      triggerLabel="Leader model and reasoning"
                      showThinkingToggle
                    />
                  </AgentRoleSettings>
                  <AgentRoleSettings
                    role="Minion"
                    description="Executes focused tasks within the Leader's plan."
                  >
                    <MinionModelRoutingSettings
                      adaptive={settings.adaptiveMinionModelRouting === true}
                      activeHarnessName={minionSelection.harness}
                      activeHarness={minionHarness}
                      harnesses={modelMenuHarnesses}
                      modelOptions={modelGroups
                        .find((group) => group.harness === minionSelection.harness)
                        ?.options.map((option) => option.model) ?? []}
                      modelLabels={modelLabels}
                      selections={minionTierSelections}
                      thinkingConfig={minionThinking}
                      onAdaptiveChange={(adaptiveMinionModelRouting) =>
                        onSettingsChange({
                          ...settings,
                          adaptiveMinionModelRouting,
                          ...(adaptiveMinionModelRouting
                            ? {
                                defaultMinionModel: minionTierSelections.standard.model,
                                mechanicalMinionModel: minionTierSelections.mechanical.model,
                                reasoningMinionModel: minionTierSelections.reasoning.model,
                              }
                            : {}),
                        })
                      }
                      onTierModelChange={changeMinionTierModel}
                      onHarnessChange={changeMinionHarness}
                      onThinkingConfigChange={(config) =>
                        onSettingsChange({
                          ...settings,
                          defaultMinionThinkingConfig: normalizeThinkingForCapability(
                            config,
                            getModelCapability(minionSelection.model, minionHarness),
                          ),
                        })
                      }
                    />
                  </AgentRoleSettings>
                </div>
              </SettingsCard>

              <SettingsCard
                title="Execution sandbox"
                description="Filesystem and approval defaults for new Leader sessions. Unsupported controls are shown as unmanaged."
              >
                <SandboxPolicyControls
                  policy={settings.defaultSandboxPolicy ?? DEFAULT_SANDBOX_POLICY}
                  support={harnessesLoaded
                    ? leaderHarness?.capabilities.sandboxEnforcement ?? null
                    : undefined}
                  onChange={(defaultSandboxPolicy) =>
                    onSettingsChange({ ...settings, defaultSandboxPolicy })
                  }
                />
              </SettingsCard>

              <SettingsCard
                title="Graph assistance"
                description="Task Graph is available for dependency reasoning and durable orchestration; Leaders keep their direct execution and delegation tools."
              >
                <ToggleRow
                  label="Disable Task Graph tools"
                  description="Debug only. New Leaders keep direct planning and delegation but do not receive graph proposal tools."
                  checked={normalizeLeaderPlanningBackend(
                    settings.leaderPlanningBackend,
                  ) === "legacy"}
                  onChange={(checked) =>
                    onSettingsChange({
                      ...settings,
                      leaderPlanningBackend: checked ? "legacy" : "task_graph",
                    })
                  }
                />
              </SettingsCard>

              <SettingsCard
                title="Role system"
                description="Beta prompt behavior for new Leader and Minion sessions."
              >
                <ToggleRow
                  label="Enable adaptive expert roles"
                  description="Let agents infer the smallest useful role contract, or refine a role supplied by you or the Leader."
                  checked={settings.roleSystemBeta === true}
                  onChange={(checked) =>
                    onSettingsChange({ ...settings, roleSystemBeta: checked })
                  }
                />
              </SettingsCard>
            </>
          )}

          {activeCategory === "workspace" && (
            <>
              <SettingsHeading
                eyebrow="Project behavior"
                title="Workspace"
                description="Control how new work is isolated and how the canvas stays organized."
              />
              <SettingsCard
                title="Source control"
                description="Keep concurrent changes separated until they are ready to review."
              >
                <ToggleRow
                  label="Isolate new Leader work"
                  description="Create a dedicated git worktree branch with approval-based merging."
                  checked={settings.defaultWorktreeIsolation !== false}
                  onChange={(checked) =>
                    onSettingsChange({ ...settings, defaultWorktreeIsolation: checked })
                  }
                />
              </SettingsCard>
              <SettingsCard
                title="Canvas layout"
                description="Keep spatial workflows legible as the project grows."
              >
                <ToggleRow
                  label="Tidy layout"
                  description="Snap to grid, prevent overlaps, and keep dashboards attached to their Leader."
                  checked={settings.tidyLayout !== false}
                  onChange={(checked) =>
                    onSettingsChange({ ...settings, tidyLayout: checked })
                  }
                />
              </SettingsCard>
            </>
          )}

          {activeCategory === "actions" && (
            <ContextActionsRecipeSettings
              settings={settings}
              onSettingsChange={onSettingsChange}
              saveState={settingsSaveState}
              onRetrySave={onRetrySettingsSave}
            />
          )}

          {activeCategory === "governance" && (
            <>
              <SettingsHeading
                eyebrow="Labs"
                title="Governance"
                beta
                description="Choose how the system model informs agents and protects merges."
              />
              <SettingsCard
                title="System model"
                description="Compile repository knowledge into Context Packs for Minions."
              >
                <div className="settings-mode-grid" role="radiogroup" aria-label="System model mode">
                  {([
                    ["off", "Off", "No model context or merge gates."],
                    ["advisory", "Advisory", "Share context without blocking merges."],
                    ["enforced", "Enforced", "Share context and block failed review gates."],
                  ] as const).map(([value, label, description]) => (
                    <label
                      key={value}
                      className="settings-mode"
                      data-active={(settings.systemModel ?? "off") === value}
                    >
                      <input
                        type="radio"
                        name="system-model-mode"
                        value={value}
                        checked={(settings.systemModel ?? "off") === value}
                        onChange={() =>
                          onSettingsChange({ ...settings, systemModel: value })
                        }
                      />
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </label>
                  ))}
                </div>
                <p className="settings-callout">
                  Requires <code>.systemmodel/manifest.yaml</code> in the worktree.
                </p>
                {settings.systemModel !== undefined
                  && settings.systemModel !== "off"
                  && (systemModelStatus?.manifestFound === false
                    || systemModelStatusUnavailable) && (
                    <div role="status" className="settings-status">
                      {systemModelStatus?.manifestFound === false
                        ? <>System model is enabled but inactive. Seed <code>.systemmodel/manifest.yaml</code>.</>
                        : <>For a new system model, seed <code>.systemmodel/manifest.yaml</code>.</>}
                    </div>
                  )}
              </SettingsCard>
            </>
          )}

        </main>
      </div>
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

function SettingsHeading({
  eyebrow,
  title,
  beta = false,
  description,
}: {
  eyebrow: string;
  title: string;
  beta?: boolean;
  description: string;
}) {
  return (
    <header className="settings-heading">
      <span>{eyebrow}</span>
      <h2>
        {title}
        {beta && <BetaBadge />}
      </h2>
      <p>{description}</p>
    </header>
  );
}

function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-card">
      <div className="settings-card__heading">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="settings-card__body">{children}</div>
    </section>
  );
}

function BetaBadge() {
  return <span className="settings-beta-badge">Beta</span>;
}

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

// ── Context actions manager ─────────────────────────────────

export function LegacyContextActionsSettings({
  settings,
  onSettingsChange,
}: {
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
}) {
  const actions = useMemo(
    () => normalizeDashboardLeaderActions(settings),
    [settings],
  );

  const commit = (next: DashboardLeaderActionConfig[]) => {
    // Writing the canonical array; strip any legacy records so no dual
    // config shape survives the round-trip.
    const { dashboardLeaderActionNames, dashboardLeaderActionPrompts, ...rest } =
      settings;
    void dashboardLeaderActionNames;
    void dashboardLeaderActionPrompts;
    onSettingsChange({ ...rest, dashboardLeaderActions: next });
  };

  const updateAction = (
    id: string,
    patch: Partial<DashboardLeaderActionConfig>,
  ) => commit(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const removeAction = (id: string) =>
    commit(actions.filter((a) => a.id !== id));

  const moveAction = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    commit(next);
  };

  const addAction = () =>
    commit([
      ...actions,
      {
        id: randomUuid(),
        name: "New action",
        prompt: "",
        icon: DEFAULT_DASHBOARD_ACTION_ICON,
        skillIds: [],
      },
    ]);

  return (
    <>
      <SettingsHeading
        eyebrow="Labs"
        title="Context actions"
        beta
        description="Build the commands the Leader offers in its slash menu. Add, rename, reorder, or remove them freely."
      />
      <div className="settings-flow">
        <span>Type /</span>
        <ChevronRight size={14} />
        <span>Pick an action</span>
        <ChevronRight size={14} />
        <span>Prompt fills the Leader</span>
      </div>
      <SettingsCard
        title="Action menu"
        description="Each action needs a short, scannable label and a precise instruction. Order here is the order shown in the menu."
      >
        {actions.length === 0 ? (
          <p className="settings-actions-empty">
            No actions yet. Add one to populate the Leader slash menu.
          </p>
        ) : (
          <ul className="settings-action-list">
            {actions.map((action, index) => (
              <ContextActionRow
                key={action.id}
                action={action}
                index={index}
                total={actions.length}
                onChange={(patch) => updateAction(action.id, patch)}
                onRemove={() => removeAction(action.id)}
                onMove={(delta) => moveAction(index, delta)}
              />
            ))}
          </ul>
        )}
        <div className="settings-action-toolbar">
          <button
            type="button"
            className="settings-action-add"
            onClick={addAction}
          >
            <Plus size={14} aria-hidden="true" />
            Add action
          </button>
          <button
            type="button"
            className="settings-action-reset"
            onClick={() => commit(defaultDashboardLeaderActions())}
          >
            <RotateCcw size={13} aria-hidden="true" />
            Reset to defaults
          </button>
        </div>
      </SettingsCard>
    </>
  );
}

function ContextActionRow({
  action,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  action: DashboardLeaderActionConfig;
  index: number;
  total: number;
  onChange: (patch: Partial<DashboardLeaderActionConfig>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  return (
    <li className="settings-action-card">
      <div className="settings-action-card__head">
        <IconPicker
          value={action.icon}
          label={action.name}
          onChange={(icon) => onChange({ icon })}
        />
        <input
          className="settings-action-card__name"
          aria-label={`Action ${index + 1} name`}
          value={action.name}
          placeholder="Action name"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <div className="settings-action-card__controls">
          <button
            type="button"
            aria-label="Move action up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ChevronUp size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Move action down"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="settings-action-card__delete"
            aria-label={`Remove ${action.name || "action"}`}
            onClick={onRemove}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <textarea
        className="settings-action-card__prompt"
        aria-label={`Action ${index + 1} prompt`}
        value={action.prompt}
        placeholder="Instruction sent to the Leader when this action is chosen…"
        rows={3}
        onChange={(e) => onChange({ prompt: e.target.value })}
      />
    </li>
  );
}

function IconPicker({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ActiveIcon = dashboardActionIcon(value);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = ref.current;
      const menu = menuRef.current;
      const dialog = trigger?.closest<HTMLElement>(".settings-dialog");
      if (!trigger || !menu || !dialog) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const inset = 8;
      const gap = 6;
      const minLeft = dialogRect.left + inset;
      const maxLeft = Math.max(minLeft, dialogRect.right - menuRect.width - inset);
      const minTop = dialogRect.top + inset;
      const maxTop = Math.max(minTop, dialogRect.bottom - menuRect.height - inset);
      const below = triggerRect.bottom + gap;
      const preferredTop = below + menuRect.height <= dialogRect.bottom - inset
        ? below
        : triggerRect.top - menuRect.height - gap;

      setMenuPosition({
        left: Math.min(Math.max(triggerRect.left, minLeft), maxLeft),
        top: Math.min(Math.max(preferredTop, minTop), maxTop),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="settings-icon-picker" ref={ref}>
      <button
        type="button"
        className="settings-icon-picker__trigger"
        aria-label={`Icon for ${label || "action"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ActiveIcon size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="settings-icon-picker__menu"
          role="menu"
          style={menuPosition ?? { visibility: "hidden" }}
        >
          {DASHBOARD_ACTION_ICONS.map(({ key, label: iconLabel, Icon }) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={key === value}
              aria-label={iconLabel}
              title={iconLabel}
              data-active={key === value}
              onClick={() => {
                onChange(key);
                setOpen(false);
              }}
            >
              <Icon size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
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
      <div className="settings-reasoning settings-reasoning--unavailable">
        Reasoning controls are unavailable for this model.
      </div>
    );
  }

  return (
    <div className="settings-reasoning">
      <label className="settings-reasoning__toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
        />
        <span>Enabled</span>
      </label>

      <div className="settings-reasoning__segment" aria-label="Reasoning effort">
        {capability.supportedEffortLevels.map((effort) => {
          const active = config.effort === effort;
          return (
            <button
              key={effort}
              type="button"
              title={EFFORT_DESCRIPTIONS[effort]}
              disabled={!config.enabled}
              onClick={() => onChange({ ...config, effort })}
              data-active={active}
            >
              {EFFORT_LABELS[effort]}
            </button>
          );
        })}
      </div>

      <div className="settings-reasoning__segment" aria-label="Reasoning output">
        {(["summarized", "omitted"] as const).map((display) => {
          const active = config.display === display;
          return (
            <button
              key={display}
              type="button"
              disabled={!config.enabled}
              onClick={() => onChange({ ...config, display })}
              data-active={active}
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
