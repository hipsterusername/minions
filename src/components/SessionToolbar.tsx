import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { MODEL_COLORS } from "../palette.ts";
import type { EffortLevel, ThinkingConfig } from "../types.ts";
import { getModelCapability } from "../model-meta.ts";
import { findHarness, type HarnessInfo } from "../harness-list.ts";
import { useHarnessList } from "../use-harness-list.tsx";

/** Claude model aliases accepted alongside model IDs from a harness inventory. */
export type ModelOption = "sonnet" | "fable" | "opus" | "opus-old" | "haiku";

export type PermissionMode =
  | "auto"
  | "bypassPermissions"
  | "default"
  | "plan"
  | "acceptEdits";

export interface SessionToolbarProps {
  /** Optional styling hook for a host surface. */
  className?: string;
  sessionKey: string | null;
  status: string;
  /** Either a Claude alias ("sonnet") or a concrete harness model id ("gpt-5.6-sol"). */
  model: string;
  permissionMode: PermissionMode;
  /** Interrupt callback. When omitted, the interrupt button is not rendered. */
  onInterrupt?: () => void;
  onModelChange: (model: string) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** Adaptive-thinking config. Hidden when the active harness/model don't support it. */
  thinkingConfig?: ThinkingConfig;
  onThinkingConfigChange?: (config: ThinkingConfig) => void;
  /** Optional accent color for theming (hex). Defaults to #60a5fa */
  accent?: string;
  /** Optional content rendered on the right side of the toolbar (e.g. skills button) */
  skillsContent?: React.ReactNode;
  /** Active harness driving this session. When omitted, use Claude defaults. */
  harness?: string;
  /**
   * Called when the user picks a harness for a not-yet-created session. When
   * omitted (or `sessionKey` is set) the harness pill renders display-only.
   * Mid-session swap is intentionally unsupported.
   *
   * The optional `defaultModel` is supplied when the current model isn't
   * valid for the new harness; the parent should apply both updates
   * atomically (a single `onUpdateData` call) to avoid clobbering the
   * harness change with a stale-ref model update.
   */
  onHarnessChange?: (harness: string, defaultModel?: string) => void;
}

/** Default Claude model labels. Used when the active harness is Claude or unknown. */
const CLAUDE_MODEL_LABELS: Record<string, string> = {
  sonnet: "Sonnet",
  fable: "Fable 5",
  opus: "Opus 4.8",
  "opus-old": "Opus 4.7",
  haiku: "Haiku",
  "claude-fable-5": "Fable 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku",
};

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  auto: "Auto",
  bypassPermissions: "Bypass",
  default: "Default",
  plan: "Plan",
  acceptEdits: "Auto-edit",
};

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  auto: "Auto-approve safe operations",
  bypassPermissions: "Skip all permission checks",
  default: "Ask before dangerous operations",
  plan: "Require plan approval first",
  acceptEdits: "Auto-approve file edits only",
};

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Skip thinking when possible — fastest, cheapest",
  medium: "Light reasoning on harder requests",
  high: "Always think (default) — deep reasoning",
  xhigh: "Deeper exploration — Opus 4.8 and GPT-5.6 Sol",
  max: "Maximum effort — GPT-5.6 Sol and supported models",
};

// Shared button style base
const pillStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 8px",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-default)",
  borderRadius: 4,
  color: "var(--text-secondary)",
  cursor: "pointer",
  position: "relative",
  whiteSpace: "nowrap",
  transition: "border-color 0.15s, background 0.15s",
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function modelColor(model: string): string | undefined {
  return (MODEL_COLORS as Record<string, string>)[model];
}

function providerLabel(harness: HarnessInfo | undefined, fallbackName: string): string {
  const provider = String(harness?.account.provider ?? fallbackName).toLowerCase();
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic" || provider === "claude") return "Anthropic";
  if (provider === "echo") return "Echo";
  return titleCase(harness?.name ?? fallbackName);
}

function providerMark(label: string): string {
  if (label === "OpenAI") return "OA";
  if (label === "Anthropic") return "A";
  return label.slice(0, 2).toUpperCase();
}

/**
 * Display order for provider tabs. OpenAI/GPT leads per product direction,
 * Anthropic next, then everything else, with the Echo test harness last.
 */
function providerRank(label: string): number {
  if (label === "OpenAI") return 0;
  if (label === "Anthropic") return 1;
  if (label === "Echo") return 9;
  return 5;
}

function Dropdown<T extends string>({
  value,
  options,
  labels,
  descriptions,
  colors,
  onChange,
  open,
  onToggle,
  disabled,
}: {
  value: T;
  options: T[];
  labels: Record<T, string>;
  descriptions?: Record<T, string>;
  colors?: Record<T, string>;
  onChange: (v: T) => void;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={disabled ? undefined : onToggle}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={disabled}
        style={{
          ...pillStyle,
          borderColor: open ? "var(--accent)" : "var(--border-default)",
          ...(disabled ? { cursor: "default", opacity: 0.6 } : {}),
        }}
      >
        {colors && colors[value] && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: colors[value],
              flexShrink: 0,
            }}
          />
        )}
        <span>{labels[value] ?? value}</span>
        {!disabled && (
          <span
            style={{
              fontSize: 7,
              opacity: 0.5,
              marginLeft: 2,
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
            }}
          >
            ▼
          </span>
        )}
      </button>

      {open && !disabled && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 100,
            minWidth: 140,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            boxShadow: "var(--shadow-lg)",
            overflow: "hidden",
          }}
        >
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                onToggle();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "7px 10px",
                background:
                  opt === value
                    ? "var(--state-active)"
                    : "transparent",
                border: "none",
                cursor: "pointer",
                color:
                  opt === value
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                textAlign: "left",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background =
                  opt === value
                    ? "var(--state-active)"
                    : "var(--state-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background =
                  opt === value
                    ? "var(--state-active)"
                    : "transparent")
              }
            >
              {colors && colors[opt] && (
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: colors[opt],
                    flexShrink: 0,
                    boxShadow:
                      opt === value
                        ? `0 0 6px ${colors[opt]}`
                        : "none",
                  }}
                />
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontWeight: opt === value ? 600 : 400 }}>
                  {labels[opt] ?? opt}
                </span>
                {descriptions && descriptions[opt] && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {descriptions[opt]}
                  </span>
                )}
              </div>
              {opt === value && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10,
                    color: "var(--accent)",
                  }}
                >
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ModelSelectionMenu({
  model,
  activeHarnessName,
  activeHarness,
  harnesses,
  modelOptions,
  modelLabels,
  capability,
  thinkingConfig,
  onModelChange,
  onHarnessChange,
  onThinkingConfigChange,
  onSelectComplete = () => {},
  hasSession,
  open = false,
  onToggle = () => {},
  layout = "popover",
  fullWidth = false,
  triggerLabel = "Model selection",
  showThinkingToggle = false,
  expanded = false,
}: {
  model: string;
  activeHarnessName: string;
  activeHarness: HarnessInfo | undefined;
  harnesses: ReadonlyArray<HarnessInfo>;
  modelOptions: string[];
  modelLabels: Record<string, string>;
  capability: ReturnType<typeof getModelCapability>;
  thinkingConfig: ThinkingConfig | undefined;
  onModelChange: (model: string) => void;
  onHarnessChange: ((harness: string, defaultModel?: string) => void) | undefined;
  onThinkingConfigChange: ((config: ThinkingConfig) => void) | undefined;
  onSelectComplete?: () => void;
  hasSession: boolean;
  open?: boolean;
  onToggle?: () => void;
  layout?: "popover" | "inline";
  fullWidth?: boolean;
  triggerLabel?: string;
  showThinkingToggle?: boolean;
  /** Render the complete menu inline without a disclosure trigger. */
  expanded?: boolean;
}) {
  const groups = (
    harnesses.length > 0
      ? harnesses.map((h) => ({
          harness: h.name,
          label: providerLabel(h, h.name),
          models: h.models.map((m) => ({ id: m.id, label: m.label })),
          locked: hasSession && h.name === activeHarnessName,
          source: h,
        }))
      : [
          {
            harness: activeHarnessName,
            label: providerLabel(activeHarness, activeHarnessName),
            models: modelOptions.map((id) => ({ id, label: modelLabels[id] ?? id })),
            locked: hasSession,
            source: activeHarness,
          },
        ]
  )
    .slice()
    .sort((a, b) => providerRank(a.label) - providerRank(b.label));

  // The provider whose models are currently listed. Provider selection drives
  // the model list (provider → model → thinking), so the active provider is
  // always the one backing the current harness. Fall back to the first tab.
  const activeGroup =
    groups.find((g) => g.harness === activeHarnessName) ?? groups[0];

  const activeHarnessLabel = providerLabel(activeHarness, activeHarnessName);
  const activeModelLabel = modelLabels[model] ?? model;
  const effortLabel =
    thinkingConfig && capability.supportsAdaptiveThinking
      ? thinkingConfig.enabled
        ? EFFORT_LABELS[thinkingConfig.effort]
        : "Off"
      : null;
  const showThinkingControls =
    capability.supportsAdaptiveThinking &&
    !!thinkingConfig &&
    !!onThinkingConfigChange;
  const isOpen = expanded || open;
  const isInline = expanded || layout === "inline";

  return (
    <div
      style={{ position: "relative", minWidth: 0 }}
      onKeyDown={(event) => {
        if (expanded || event.key !== "Escape" || !isOpen) return;
        event.stopPropagation();
        onToggle();
      }}
    >
      {!expanded && <button
        type="button"
        onClick={onToggle}
        onMouseDown={(e) => e.stopPropagation()}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={triggerLabel}
        style={{
          ...pillStyle,
          minHeight: 24,
          gap: 6,
          width: fullWidth ? "100%" : undefined,
          justifyContent: "flex-start",
          textAlign: "left",
          borderColor: isOpen ? "var(--accent)" : "var(--border-default)",
        }}
        title={triggerLabel}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            border: "1px solid var(--border-default)",
            background: "var(--bg-secondary)",
            color: "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 8,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {providerMark(activeHarnessLabel)}
        </span>
        <span>{activeHarnessLabel}</span>
        <span style={{ color: "var(--text-muted)" }}>·</span>
        <span
          style={{
            color: "var(--text-primary)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {activeModelLabel}
        </span>
        {effortLabel && (
          <>
            <span style={{ color: "var(--text-muted)" }}>·</span>
            <span>{effortLabel}</span>
          </>
        )}
        <span
          style={{
            fontSize: 7,
            opacity: 0.5,
            marginLeft: fullWidth ? "auto" : 2,
            flexShrink: 0,
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        >
          ▼
        </span>
      </button>}

      {isOpen && (
        <div
          role={expanded ? "group" : "dialog"}
          aria-label={expanded ? triggerLabel : `${triggerLabel} menu`}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: isInline ? "relative" : "absolute",
            top: isInline ? "auto" : "calc(100% + 4px)",
            left: 0,
            zIndex: 100,
            width: isInline ? "100%" : 300,
            maxWidth: isInline ? "100%" : "calc(100vw - 24px)",
            maxHeight: isInline ? "none" : "min(60vh, 420px)",
            overflowY: "auto",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: expanded ? 0 : isInline ? 6 : 0,
            boxShadow: isInline ? "none" : "var(--shadow-lg)",
          }}
        >
          {/* Level 1 — Provider. Selecting a provider commits its harness and
              preselects that provider's default (first) model. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div
              style={{
                fontSize: 9,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                padding: "0 2px",
              }}
            >
              Provider
            </div>
            <div
              role="tablist"
              aria-label="Provider"
              style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
            >
              {groups.map((group) => {
                const isActiveProvider = group.harness === activeHarnessName;
                const selectable = !hasSession || isActiveProvider;
                return (
                  <button
                    key={group.harness}
                    role="tab"
                    aria-selected={isActiveProvider}
                    disabled={!selectable}
                    title={
                      selectable
                        ? group.label
                        : `${group.label} — fixed for session`
                    }
                    onClick={() => {
                      if (isActiveProvider || !selectable) return;
                      const defaultModel = group.models[0]?.id;
                      onHarnessChange?.(group.harness, defaultModel);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      ...pillStyle,
                      gap: 6,
                      borderColor: isActiveProvider
                        ? "var(--accent)"
                        : "var(--border-default)",
                      background: isActiveProvider
                        ? "var(--state-active)"
                        : "var(--bg-primary)",
                      color: isActiveProvider
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                      cursor: selectable ? "pointer" : "default",
                      opacity: selectable ? 1 : 0.5,
                    }}
                  >
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        border: "1px solid var(--border-default)",
                        background: "var(--bg-secondary)",
                        color: "var(--text-secondary)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 8,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {providerMark(group.label)}
                    </span>
                    {group.label}
                  </button>
                );
              })}
            </div>
            {hasSession && (
              <div
                style={{
                  fontSize: 9,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  fontStyle: "italic",
                  padding: "0 2px",
                }}
              >
                fixed for session
              </div>
            )}
          </div>

          {activeGroup && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div
              style={{
                fontSize: 9,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                padding: "0 2px",
              }}
            >
              {activeGroup.label} Model
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4 }}>
              {activeGroup.models.map((option) => {
                const isActive = option.id === model;
                return (
                  <button
                    key={`${activeGroup.harness}:${option.id}`}
                    onClick={() => {
                      onModelChange(option.id);
                      if (!expanded) onSelectComplete();
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: 4,
                      border: isActive
                        ? "1px solid var(--accent)"
                        : "1px solid var(--border-default)",
                      background: isActive
                        ? "var(--state-active)"
                        : "var(--bg-primary)",
                      color: isActive
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        width: 3,
                        alignSelf: "stretch",
                        borderRadius: 2,
                        background: modelColor(option.id) ?? "var(--accent)",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                        fontWeight: isActive ? 600 : 500,
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {option.label}
                    </span>
                    {isActive && (
                      <span style={{ color: "var(--accent)", fontSize: 10 }}>✓</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {showThinkingControls && thinkingConfig && onThinkingConfigChange && (
            <div
              style={{
                borderTop: "1px solid var(--border-default)",
                paddingTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 7,
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                }}
              >
                Reasoning
              </div>
              {showThinkingToggle && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    minHeight: 28,
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  <span>
                    <strong
                      style={{
                        display: "block",
                        color: "var(--text-primary)",
                        fontSize: 10,
                      }}
                    >
                      Adaptive reasoning
                    </strong>
                    <span style={{ color: "var(--text-muted)", fontSize: 9 }}>
                      Let this role reason before responding.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={thinkingConfig.enabled}
                    onChange={(event) =>
                      onThinkingConfigChange({
                        ...thinkingConfig,
                        enabled: event.target.checked,
                      })
                    }
                    style={{ accentColor: "var(--accent)" }}
                  />
                </label>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {capability.supportedEffortLevels.map((effort) => {
                  const active = thinkingConfig.effort === effort;
                  const disabled = showThinkingToggle && !thinkingConfig.enabled;
                  return (
                    <button
                      key={effort}
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        onThinkingConfigChange({ ...thinkingConfig, effort })
                      }
                      onMouseDown={(e) => e.stopPropagation()}
                      title={EFFORT_DESCRIPTIONS[effort]}
                      style={{
                        ...pillStyle,
                        borderColor: active ? "var(--accent)" : "var(--border-default)",
                        background: active ? "var(--state-active)" : "var(--bg-primary)",
                        color: active ? "var(--text-primary)" : "var(--text-secondary)",
                        opacity: disabled ? 0.45 : 1,
                        cursor: disabled ? "default" : "pointer",
                      }}
                    >
                      {EFFORT_LABELS[effort]}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["summarized", "omitted"] as const).map((display) => {
                  const active = thinkingConfig.display === display;
                  const disabled = showThinkingToggle && !thinkingConfig.enabled;
                  return (
                    <button
                      key={display}
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        onThinkingConfigChange({ ...thinkingConfig, display })
                      }
                      onMouseDown={(e) => e.stopPropagation()}
                      style={{
                        ...pillStyle,
                        borderColor: active ? "var(--accent)" : "var(--border-default)",
                        background: active ? "var(--state-active)" : "var(--bg-primary)",
                        color: active ? "var(--text-primary)" : "var(--text-secondary)",
                        opacity: disabled ? 0.45 : 1,
                        cursor: disabled ? "default" : "pointer",
                      }}
                    >
                      {display === "summarized" ? "Summaries" : "Hidden"}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionToolbar({
  className,
  sessionKey,
  status,
  model,
  permissionMode,
  onInterrupt,
  onModelChange,
  onPermissionModeChange,
  thinkingConfig,
  onThinkingConfigChange,
  skillsContent,
  harness,
  onHarnessChange,
}: SessionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);

  const isRunning = status === "running" || status === "creating";
  const hasSession = !!sessionKey;

  const { harnesses, loaded: harnessesLoaded } = useHarnessList();
  const activeHarness = findHarness(harnesses, harness);
  const harnessCapabilities = activeHarness?.capabilities;

  // Models the active harness can resolve. Falls back to the existing
  // Claude alias set when the inventory hasn't loaded — keeps the UI
  // populated on the very first paint before the WS roundtrip lands.
  const modelOptions = useMemo<string[]>(() => {
    if (activeHarness && activeHarness.models.length > 0) {
      return activeHarness.models.map((m) => m.id);
    }
    return ["fable", "sonnet", "opus", "opus-old", "haiku"];
  }, [activeHarness]);

  const modelLabels = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = { ...CLAUDE_MODEL_LABELS };
    if (activeHarness) {
      for (const m of activeHarness.models) {
        map[m.id] = m.label;
      }
    }
    return map;
  }, [activeHarness]);

  // Per-model capability — gated by the harness's overall thinking flag
  // first, then by the model entry.
  const capability = getModelCapability(model, activeHarness);

  // Provider-neutral sandbox controls are the sole permission authority for
  // harnesses that enforce them. Legacy permission modes remain available for
  // harnesses such as Claude that expose their own runtime permission model.
  const permissionOptions = useMemo<PermissionMode[]>(() => {
    const all: PermissionMode[] = [
      "auto",
      "bypassPermissions",
      "default",
      "plan",
      "acceptEdits",
    ];
    if (!harnessCapabilities) return all;
    if (harnessCapabilities.sandboxEnforcement?.approval === true) return [];
    if (!harnessCapabilities.permissionPrompts) return [];
    return all;
  }, [harnessCapabilities]);

  const activeHarnessName = harness ?? activeHarness?.name ?? "claude";
  const modelPickerHarnesses = useMemo<ReadonlyArray<HarnessInfo>>(() => {
    if (!harnessesLoaded || harnesses.length === 0) return [];
    if (!hasSession && !!onHarnessChange) return harnesses;
    if (hasSession) return harnesses;
    return activeHarness ? [activeHarness] : [];
  }, [activeHarness, harnesses, harnessesLoaded, hasSession, onHarnessChange]);

  // Capability gates for live-run controls. Hide when the harness can't
  // honour them rather than asking the server only to be told it's
  // unsupported. We *don't* hide model/permission selectors — those are
  // also legitimately changed before the run starts.
  const showInterrupt =
    !!onInterrupt &&
    (!harnessCapabilities || harnessCapabilities.partialMessages);

  const closeAll = useCallback(() => {
    setModelPickerOpen(false);
    setPermOpen(false);
  }, []);

  useEffect(() => {
    if (!modelPickerOpen && !permOpen) return;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && toolbarRef.current?.contains(target)) return;
      closeAll();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };

    // Capture phase matters here because chat/canvas surfaces commonly stop
    // propagation to prevent node dragging or canvas selection.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeAll, modelPickerOpen, permOpen]);

  return (
    <div
      ref={toolbarRef}
      className={className}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px",
        borderBottom: "1px solid var(--border-default)",
        background: "var(--bg-primary)",
        flexShrink: 0,
        flexWrap: "wrap",
        minHeight: 30,
      }}
    >
      <ModelSelectionMenu
        model={model}
        activeHarnessName={activeHarnessName}
        activeHarness={activeHarness}
        harnesses={modelPickerHarnesses}
        modelOptions={modelOptions}
        modelLabels={modelLabels}
        capability={capability}
        thinkingConfig={thinkingConfig}
        onModelChange={onModelChange}
        onHarnessChange={onHarnessChange}
        onThinkingConfigChange={onThinkingConfigChange}
        onSelectComplete={closeAll}
        hasSession={hasSession}
        open={modelPickerOpen}
        onToggle={() => {
          setModelPickerOpen(!modelPickerOpen);
          setPermOpen(false);
        }}
      />

      {permissionOptions.length > 0 && (
        <Dropdown
          value={permissionMode}
          options={permissionOptions}
          labels={PERMISSION_LABELS}
          descriptions={PERMISSION_DESCRIPTIONS}
          onChange={(m) => {
            onPermissionModeChange(m);
            closeAll();
          }}
          open={permOpen}
          onToggle={() => {
            setPermOpen(!permOpen);
            setModelPickerOpen(false);
          }}
        />
      )}

      <div style={{ flex: 1 }} />

      {skillsContent}

      {hasSession && isRunning && showInterrupt && (
        <button
          onClick={onInterrupt}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 10px",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-color)",
            borderRadius: 4,
            color: "var(--status-error)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--danger-bg)";
            e.currentTarget.style.borderColor = "var(--danger-color)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--danger-bg)";
            e.currentTarget.style.borderColor = "var(--danger-bg)";
          }}
        >
          <span style={{ fontSize: 8, lineHeight: 1 }}>■</span>
          Interrupt
        </button>
      )}

      {hasSession && status === "stopped" && (
        <span
          className="session-toolbar__status-hint"
          style={{
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontStyle: "italic",
          }}
        >
          interrupted
        </span>
      )}
    </div>
  );
}

export default SessionToolbar;
