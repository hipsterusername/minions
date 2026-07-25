import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Copy,
  Download,
  MoreHorizontal,
  Network,
  RotateCcw,
  Save,
} from "lucide-react";
import type { LeaderData } from "./types.ts";

/**
 * Overflow menu for secondary Leader actions. The visual treatment mirrors
 * the project Settings popover: one elevated surface, clear grouping, and
 * comfortably sized controls.
 */
export function HeaderMenu({
  onReset,
  onExportLog,
  onDuplicateSetup,
  onOpenSystemModel,
  onSavePreset,
  data,
}: {
  onReset: () => void;
  onExportLog: () => void;
  onDuplicateSetup?: (() => void) | undefined;
  onOpenSystemModel?: (() => void) | undefined;
  onSavePreset?:
    | ((input: {
        name: string;
        description?: string;
        systemPromptPrefix?: string;
      }) => boolean)
    | undefined;
  data: LeaderData;
}) {
  const [open, setOpen] = useState(false);
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetDescription, setPresetDescription] = useState("");
  const [presetSystemPromptPrefix, setPresetSystemPromptPrefix] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnWheel = () => setOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("wheel", closeOnWheel, { passive: true, once: true });
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("wheel", closeOnWheel);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setSaveFormOpen(false);
  };

  return (
    <div ref={menuRef} className="leader-header-menu">
      <button
        type="button"
        className="leader-node__icon-button"
        onClick={() => setOpen((value) => !value)}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="More leader actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
      >
        <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
      </button>

      {open && (
        <>
          <button
            type="button"
            className="leader-header-menu__backdrop"
            onClick={close}
            aria-label="Close leader actions"
            tabIndex={-1}
          />
          <div
            className="leader-header-menu__popover"
            role="menu"
            aria-label="Leader actions"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="leader-header-menu__label">Leader actions</div>

            {onSavePreset && (
              <>
                <MenuItem
                  icon={<Save size={14} />}
                  onClick={() => setSaveFormOpen((value) => !value)}
                  expanded={saveFormOpen}
                  trailing={
                    <ChevronDown
                      size={12}
                      className="leader-header-menu__chevron"
                      data-open={saveFormOpen}
                    />
                  }
                >
                  Save as preset
                </MenuItem>
                {saveFormOpen && (
                  <div className="leader-header-menu__form">
                    <label>
                      <span>Name</span>
                      <input
                        value={presetName}
                        onChange={(event) => setPresetName(event.currentTarget.value)}
                        placeholder="My leader preset"
                        autoFocus
                      />
                    </label>
                    <label>
                      <span>Description</span>
                      <input
                        value={presetDescription}
                        onChange={(event) =>
                          setPresetDescription(event.currentTarget.value)
                        }
                        placeholder="What this setup is for"
                      />
                    </label>
                    <label>
                      <span>System prompt prefix</span>
                      <textarea
                        value={presetSystemPromptPrefix}
                        onChange={(event) =>
                          setPresetSystemPromptPrefix(event.currentTarget.value)
                        }
                        placeholder="Optional instructions"
                        rows={3}
                      />
                    </label>
                    <button
                      type="button"
                      className="leader-header-menu__save"
                      onClick={() => {
                        if (!presetName.trim()) return;
                        const saved = onSavePreset({
                          name: presetName,
                          description: presetDescription,
                          systemPromptPrefix: presetSystemPromptPrefix,
                        });
                        if (!saved) return;
                        close();
                        setPresetName("");
                        setPresetDescription("");
                        setPresetSystemPromptPrefix("");
                      }}
                      disabled={!presetName.trim()}
                    >
                      Save preset
                    </button>
                  </div>
                )}
              </>
            )}

            {onDuplicateSetup && (
              <MenuItem
                icon={<Copy size={14} />}
                onClick={() => {
                  onDuplicateSetup();
                  close();
                }}
              >
                Duplicate setup
              </MenuItem>
            )}
            {onOpenSystemModel && data.sessionKey && (
              <MenuItem
                icon={<Network size={14} />}
                onClick={() => {
                  onOpenSystemModel();
                  close();
                }}
              >
                Open system model
              </MenuItem>
            )}
            <MenuItem
              icon={<Download size={14} />}
              onClick={() => {
                onExportLog();
                close();
              }}
            >
              Export log
            </MenuItem>

            {data.sessionKey && (
              <>
                <div className="leader-header-menu__divider" />
                <MenuItem
                  icon={<RotateCcw size={14} />}
                  tone="danger"
                  onClick={() => {
                    onReset();
                    close();
                  }}
                >
                  Reset session
                </MenuItem>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  children,
  icon,
  trailing,
  onClick,
  tone = "default",
  expanded,
}: {
  children: ReactNode;
  icon: ReactNode;
  trailing?: ReactNode;
  onClick: () => void;
  tone?: "default" | "danger";
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="leader-header-menu__item"
      data-tone={tone}
      onClick={onClick}
      aria-expanded={expanded}
    >
      <span className="leader-header-menu__item-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
      {trailing}
    </button>
  );
}
