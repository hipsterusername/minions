import { useState, useCallback } from "react";
import { MODEL_COLORS, COLORS } from "../palette.ts";

export type ModelOption = "sonnet" | "opus" | "haiku";
export type PermissionMode =
  | "auto"
  | "bypassPermissions"
  | "default"
  | "plan"
  | "acceptEdits";

export interface SessionToolbarProps {
  sessionKey: string | null;
  status: string;
  model: ModelOption;
  permissionMode: PermissionMode;
  onInterrupt: () => void;
  onModelChange: (model: ModelOption) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** Optional accent color for theming (hex). Defaults to #60a5fa */
  accent?: string;
  /** Optional content rendered on the right side of the toolbar (e.g. skills button) */
  skillsContent?: React.ReactNode;
}

const MODEL_LABELS: Record<ModelOption, string> = {
  sonnet: "Sonnet",
  opus: "Opus 4.6",
  haiku: "Haiku",
};

const MODEL_COLOR: Record<string, string> = MODEL_COLORS;

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

function Dropdown<T extends string>({
  value,
  options,
  labels,
  descriptions,
  colors,
  onChange,
  open,
  onToggle,
}: {
  value: T;
  options: T[];
  labels: Record<T, string>;
  descriptions?: Record<T, string>;
  colors?: Record<T, string>;
  onChange: (v: T) => void;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={onToggle}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          ...pillStyle,
          borderColor: open ? "var(--accent)" : "var(--border-default)",
        }}
      >
        {colors && (
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
        <span>{labels[value]}</span>
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
      </button>

      {open && (
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
              {colors && (
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
                  {labels[opt]}
                </span>
                {descriptions && (
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

export function SessionToolbar({
  sessionKey,
  status,
  model,
  permissionMode,
  onInterrupt,
  onModelChange,
  onPermissionModeChange,
  skillsContent,
}: SessionToolbarProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);

  const isRunning = status === "running" || status === "creating";
  const hasSession = !!sessionKey;

  const closeAll = useCallback(() => {
    setModelOpen(false);
    setPermOpen(false);
  }, []);

  return (
    <div
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
      {/* Model selector */}
      <Dropdown
        value={model}
        options={["sonnet", "opus", "haiku"] as ModelOption[]}
        labels={MODEL_LABELS}
        colors={MODEL_COLOR}
        onChange={(m) => {
          onModelChange(m);
          closeAll();
        }}
        open={modelOpen}
        onToggle={() => {
          setModelOpen(!modelOpen);
          setPermOpen(false);
        }}
      />

      {/* Permission mode selector */}
      <Dropdown
        value={permissionMode}
        options={
          [
            "auto",
            "bypassPermissions",
            "default",
            "plan",
            "acceptEdits",
          ] as PermissionMode[]
        }
        labels={PERMISSION_LABELS}
        descriptions={PERMISSION_DESCRIPTIONS}
        onChange={(m) => {
          onPermissionModeChange(m);
          closeAll();
        }}
        open={permOpen}
        onToggle={() => {
          setPermOpen(!permOpen);
          setModelOpen(false);
        }}
      />

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Skills content (right side) */}
      {skillsContent}

      {/* Interrupt button */}
      {hasSession && isRunning && (
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

      {/* Stopped/idle resume hint */}
      {hasSession && status === "stopped" && (
        <span
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
