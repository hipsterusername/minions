import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSettings } from "./api.ts";
import { useTheme } from "./use-theme.ts";
import { useHarnessList } from "./use-harness-list.tsx";
import type { HarnessInfo } from "./harness-list.ts";

interface SettingsMenuProps {
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
}

/**
 * Header-anchored settings menu. Renders a gear button in the project
 * header; clicking opens a popover with theme + per-project preferences.
 */
export function SettingsMenu({ settings, onSettingsChange }: SettingsMenuProps) {
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
        />
      )}
    </div>
  );
}

// ── Popover body ────────────────────────────────────────────

function SettingsPopover({
  settings,
  onSettingsChange,
}: {
  settings: ProjectSettings;
  onSettingsChange: (settings: ProjectSettings) => void;
}) {
  const { themeId, setTheme, themes: allThemes } = useTheme();
  const { harnesses, loaded: harnessesLoaded } = useHarnessList();
  const modelGroups = useMemo(
    () => buildModelGroups(harnesses, harnessesLoaded),
    [harnesses, harnessesLoaded],
  );
  const leaderSelection = resolveModelSelection(
    settings.defaultLeaderHarness ?? "claude",
    settings.defaultLeaderModel ?? settings.defaultModel ?? "claude-opus-4-7",
    modelGroups,
  );
  const minionSelection = resolveModelSelection(
    settings.defaultMinionHarness ?? "claude",
    settings.defaultMinionModel ?? settings.defaultModel ?? "claude-sonnet-4-6",
    modelGroups,
  );

  return (
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
          })
        }
      />
      <FieldHint>Harness and model used when spawning new Leader nodes</FieldHint>

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
          })
        }
      />
      <FieldHint>Harness and model used when spawning new Minion nodes</FieldHint>

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
    </div>
  );
}

// ── Model settings helpers ─────────────────────────────────

interface ModelGroup {
  harness: string;
  label: string;
  options: Array<{ value: string; label: string; model: string; harness: string }>;
}

const FALLBACK_MODEL_GROUPS: ModelGroup[] = [
  {
    harness: "claude",
    label: "Anthropic",
    options: [
      {
        value: "claude::claude-opus-4-7",
        label: "Opus 4.7",
        model: "claude-opus-4-7",
        harness: "claude",
      },
      {
        value: "claude::claude-sonnet-4-6",
        label: "Sonnet 4.6",
        model: "claude-sonnet-4-6",
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
  opus: "claude-opus-4-7",
  "opus-old": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  "gpt-5": "gpt-5.5",
  "gpt-5-codex": "gpt-5.5",
};

function buildModelGroups(
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

function resolveModelSelection(
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

// ── Small layout helpers ────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
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

function ModelSelect({
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
