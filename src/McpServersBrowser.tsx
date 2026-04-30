/**
 * Floating panel for browsing, adding, editing, and deleting MCP server
 * entries stored in `.claude-canvas/mcp-servers.json`. Mirrors the design
 * and placement style of SkillsBrowser.
 */

import { useState, useEffect, useCallback } from "react";
import {
  listProjectMcpServers,
  saveProjectMcpServer,
  deleteProjectMcpServer,
} from "./api.ts";
import type { McpServerEntry } from "../shared/mcp-servers/types.ts";
import {
  DockPanel,
  DockPanelHeader,
  useDockBadge,
  useDockPanelOpen,
} from "./BottomRightDock.tsx";
import {
  parsePastedMcpConfig,
  splitArgsLine,
  type PastedDraft,
} from "./mcp-paste-parser.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type Transport = "stdio" | "sse" | "http";

interface DraftEntry {
  id: string;
  name: string;
  description: string;
  transport: Transport;
  // stdio
  command: string;
  args: string; // space-separated raw input
  env: string;  // KEY=VALUE pairs, one per line
  // sse / http
  url: string;
  headers: string; // KEY=VALUE pairs, one per line
  // shared optional
  toolNames: string; // comma-separated raw input
}

function emptyDraft(): DraftEntry {
  return {
    id: "",
    name: "",
    description: "",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
    toolNames: "",
  };
}

function entryToDraft(e: McpServerEntry): DraftEntry {
  const base: DraftEntry = {
    id: e.id,
    name: e.name,
    description: e.description ?? "",
    transport: e.transport,
    command: "",
    args: "",
    env: "",
    url: "",
    headers: "",
    toolNames: e.toolNames ? e.toolNames.join(", ") : "",
  };
  if (e.transport === "stdio") {
    base.command = e.command;
    base.args = e.args ? e.args.join(" ") : "";
    base.env = e.env
      ? Object.entries(e.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "";
  } else {
    base.url = e.url;
    base.headers = e.headers
      ? Object.entries(e.headers)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "";
  }
  return base;
}

function draftToEntry(d: DraftEntry): McpServerEntry {
  const toolNames = d.toolNames
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const base = {
    id: d.id.trim(),
    name: d.name.trim(),
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(toolNames.length > 0 ? { toolNames } : {}),
  };

  if (d.transport === "stdio") {
    const args = splitArgsLine(d.args);
    const env = parseKvLines(d.env);
    return {
      ...base,
      transport: "stdio",
      command: d.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  const headers = parseKvLines(d.headers);
  return {
    ...base,
    transport: d.transport,
    url: d.url.trim(),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function parseKvLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const actionButtonStyle: React.CSSProperties = {
  fontSize: 14,
  padding: "2px 4px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--text-muted)",
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 3,
  lineHeight: 1,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  fontSize: 12,
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 5,
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontFamily: "var(--font-mono)",
  display: "block",
  marginBottom: 3,
};

// ── Paste-to-prefill ──────────────────────────────────────────────────────────

/**
 * Merge a parser-produced partial draft into the existing draft. Only
 * fields the parser inferred get overwritten — anything the user already
 * typed into a field the parser left blank is preserved.
 */
function mergePastedDraft(prev: DraftEntry, pasted: PastedDraft): DraftEntry {
  const next: DraftEntry = { ...prev, transport: pasted.transport };
  // Switching transports clears the inputs that no longer apply so stale
  // values from the prior transport don't get silently saved.
  if (pasted.transport === "stdio") {
    next.url = "";
    next.headers = "";
  } else {
    next.command = "";
    next.args = "";
    next.env = "";
  }
  if (pasted.id !== undefined) next.id = pasted.id;
  if (pasted.name !== undefined) next.name = pasted.name;
  if (pasted.description !== undefined) next.description = pasted.description;
  if (pasted.command !== undefined) next.command = pasted.command;
  if (pasted.args !== undefined) next.args = pasted.args;
  if (pasted.env !== undefined) next.env = pasted.env;
  if (pasted.url !== undefined) next.url = pasted.url;
  if (pasted.headers !== undefined) next.headers = pasted.headers;
  if (pasted.toolNames !== undefined) next.toolNames = pasted.toolNames;
  return next;
}

interface PasteBoxProps {
  /** Called with the parsed draft when the user clicks Prefill. */
  onApply(draft: PastedDraft, warnings: string[]): void;
}

/**
 * Paste-first entry point for adding a new MCP server. Always-visible
 * textarea: vendors publish copy-paste install lines and this is the
 * primary way to get them in. Manual fields live behind the Advanced
 * disclosure rendered by McpServerForm.
 */
function PasteBox({ onApply }: PasteBoxProps) {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [prefilled, setPrefilled] = useState(false);

  const handleParse = () => {
    setError("");
    setWarnings([]);
    setPrefilled(false);
    const result = parsePastedMcpConfig(raw);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWarnings(result.warnings);
    onApply(result.draft, result.warnings);
    setPrefilled(true);
    setRaw("");
  };

  return (
    <div
      style={{
        padding: "10px 12px",
        borderBottom: "1px solid var(--border-default)",
        background: "var(--bg-surface)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontFamily: "var(--font-mono)",
          marginBottom: 4,
        }}
      >
        Paste install line, JSON, or URL
      </div>
      <textarea
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          if (prefilled) setPrefilled(false);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder={
          "npx -y @modelcontextprotocol/server-filesystem ~/Documents\n" +
          "— or —\n" +
          "claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ~\n" +
          "— or —\n" +
          '{"mcpServers": {"filesystem": {"command": "npx", "args": [...]}}}'
        }
        rows={4}
        style={{ ...inputStyle, resize: "vertical", marginBottom: 6 }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={handleParse}
          disabled={!raw.trim()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            padding: "5px 12px",
            fontSize: 11,
            background: "var(--accent)",
            border: "none",
            borderRadius: 4,
            color: "#fff",
            cursor: raw.trim() ? "pointer" : "not-allowed",
            fontFamily: "var(--font-mono)",
            opacity: raw.trim() ? 1 : 0.5,
          }}
        >
          Prefill form
        </button>
        {raw && (
          <button
            type="button"
            onClick={() => {
              setRaw("");
              setError("");
              setWarnings([]);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              padding: "5px 12px",
              fontSize: 11,
              background: "transparent",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            Clear
          </button>
        )}
      </div>
      {prefilled && !error && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--success-color, #4caf50)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ✓ Prefilled. Review fields below and Save.
        </div>
      )}
      {error && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--danger-color)",
            padding: "4px 8px",
            borderRadius: 4,
            border: "1px solid var(--danger-color)",
            background: "var(--bg-primary)",
          }}
        >
          {error}
        </div>
      )}
      {warnings.length > 0 && (
        <ul
          style={{
            marginTop: 6,
            marginBottom: 4,
            paddingLeft: 18,
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {warnings.map((w, idx) => (
            <li key={idx}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────────

interface FormProps {
  draft: DraftEntry;
  isNew: boolean;
  saving: boolean;
  error: string;
  onChange(d: DraftEntry): void;
  onSave(): void;
  onCancel(): void;
}

export function McpServerForm({
  draft,
  isNew,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
}: FormProps) {
  // Manual fields are collapsed by default for a new server (paste-first
  // workflow) and expanded when editing (paste isn't shown). A successful
  // paste auto-expands the section so the user can review.
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(!isNew);

  const field = (key: keyof DraftEntry) => ({
    value: draft[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange({ ...draft, [key]: e.target.value }),
    style: inputStyle,
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  });

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column" }}
    >
      {isNew && (
        <PasteBox
          onApply={(pasted) => {
            onChange(mergePastedDraft(draft, pasted));
            setAdvancedOpen(true);
          }}
        />
      )}

      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>
          {isNew ? "Add MCP Server" : "Edit MCP Server"}
        </div>

        {/* Advanced disclosure — manual fields */}
        {isNew ? (
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-expanded={advancedOpen}
            style={{
              alignSelf: "flex-start",
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              cursor: "pointer",
              padding: 0,
            }}
          >
            {advancedOpen ? "▾" : "▸"} Advanced (edit fields manually)
          </button>
        ) : null}

        {advancedOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <label style={labelStyle}>ID</label>
              <input {...field("id")} disabled={!isNew} placeholder="my-server" />
            </div>
            <div>
              <label style={labelStyle}>Display Name</label>
              <input {...field("name")} placeholder="My Server" />
            </div>
            <div>
              <label style={labelStyle}>Description (optional)</label>
              <input {...field("description")} placeholder="What this server does" />
            </div>
            <div>
              <label style={labelStyle}>Transport</label>
              <select
                value={draft.transport}
                onChange={(e) =>
                  onChange({ ...draft, transport: e.target.value as Transport })
                }
                style={{ ...inputStyle, cursor: "pointer" }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <option value="stdio">stdio</option>
                <option value="sse">SSE</option>
                <option value="http">HTTP</option>
              </select>
            </div>

            {draft.transport === "stdio" ? (
              <>
                <div>
                  <label style={labelStyle}>Command</label>
                  <input {...field("command")} placeholder="npx" />
                </div>
                <div>
                  <label style={labelStyle}>Args (space-separated)</label>
                  <input {...field("args")} placeholder="-y my-mcp-package" />
                </div>
                <div>
                  <label style={labelStyle}>Env vars (KEY=VALUE, one per line)</label>
                  <textarea
                    {...field("env")}
                    rows={3}
                    placeholder={"API_KEY=abc\nDEBUG=true"}
                    style={{ ...inputStyle, resize: "vertical" }}
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label style={labelStyle}>URL</label>
                  <input {...field("url")} placeholder="https://example.com/mcp" />
                </div>
                <div>
                  <label style={labelStyle}>Headers (KEY=VALUE, one per line)</label>
                  <textarea
                    {...field("headers")}
                    rows={3}
                    placeholder="Authorization=Bearer token"
                    style={{ ...inputStyle, resize: "vertical" }}
                  />
                </div>
              </>
            )}

            <div>
              <label style={labelStyle}>Tool names (comma-separated, optional)</label>
              <input {...field("toolNames")} placeholder="read_file, write_file" />
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              fontSize: 11,
              color: "var(--danger-color)",
              background: "var(--bg-primary)",
              padding: "4px 8px",
              borderRadius: 4,
              border: "1px solid var(--danger-color)",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
          <button
            onClick={onSave}
            disabled={saving}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              padding: "5px 0",
              fontSize: 11,
              background: "var(--accent)",
              border: "none",
              borderRadius: 5,
              color: "#fff",
              cursor: saving ? "not-allowed" : "pointer",
              fontFamily: "var(--font-mono)",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onCancel}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              padding: "5px 12px",
              fontSize: 11,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              borderRadius: 5,
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface McpServersBrowserProps {
  projectId: string;
  refreshKey?: number;
}

export function McpServersBrowser({ projectId, refreshKey }: McpServersBrowserProps) {
  const isOpen = useDockPanelOpen("mcp");
  const [entries, setEntries] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingDraft, setEditingDraft] = useState<DraftEntry>(emptyDraft());
  const [isNew, setIsNew] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    listProjectMcpServers(projectId)
      .then(({ entries: e }) => setEntries(e))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load, refreshKey]);

  // Surface entry count as a live badge on the dock pill, even while
  // collapsed. Loads once on first projectId.
  useEffect(() => {
    if (!projectId) return;
    listProjectMcpServers(projectId)
      .then(({ entries: e }) => setEntries(e))
      .catch(() => {});
  }, [projectId]);

  useDockBadge("mcp", { count: entries.length });

  const openNew = () => {
    setEditingDraft(emptyDraft());
    setIsNew(true);
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (entry: McpServerEntry) => {
    setEditingDraft(entryToDraft(entry));
    setIsNew(false);
    setFormError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    setFormError("");
    setSaving(true);
    try {
      const entry = draftToEntry(editingDraft);
      await saveProjectMcpServer(projectId, entry);
      load();
      setShowForm(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProjectMcpServer(projectId, id);
      load();
    } catch {
      // surface in UI later; for now silently reload
      load();
    }
  };

  if (!isOpen) return null;

  // ── Expanded panel ──

  return (
    <DockPanel id="mcp" width={320}>
      <DockPanelHeader
        title={<>MCP Servers ({entries.length})</>}
        actions={
          <button
            onClick={openNew}
            onMouseDown={(e) => e.stopPropagation()}
            title="Add MCP Server"
            aria-label="Add MCP server"
            style={actionButtonStyle}
          >
            +
          </button>
        }
      />

      {/* Form */}
      {showForm && (
        <div
          style={{
            borderBottom: "1px solid var(--border-default)",
            overflowY: "auto",
            flexShrink: 0,
            maxHeight: 420,
          }}
        >
          <McpServerForm
            draft={editingDraft}
            isNew={isNew}
            saving={saving}
            error={formError}
            onChange={setEditingDraft}
            onSave={() => { void handleSave(); }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {/* Entry list */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px" }}>
        {loading && (
          <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: 11 }}>
            Loading…
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div
            style={{
              padding: "20px 12px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 11,
            }}
          >
            <div style={{ fontStyle: "italic", marginBottom: 8 }}>
              No MCP servers yet
            </div>
            <button
              onClick={openNew}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                padding: "4px 12px",
                fontSize: 11,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
              }}
            >
              + Add Server
            </button>
          </div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.id}
            style={{
              marginBottom: 4,
              borderRadius: 6,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              display: "flex",
              alignItems: "flex-start",
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => openEdit(entry)}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                flex: 1,
                padding: "8px 10px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  marginBottom: 2,
                }}
              >
                {entry.name}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {entry.transport}
                {entry.transport === "stdio" ? ` · ${entry.command}` : ` · ${entry.url}`}
              </div>
              {entry.description && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    marginTop: 2,
                    lineHeight: 1.3,
                  }}
                >
                  {entry.description}
                </div>
              )}
            </button>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "4px 4px 4px 0",
                gap: 2,
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => openEdit(entry)}
                onMouseDown={(e) => e.stopPropagation()}
                title="Edit"
                style={actionButtonStyle}
              >
                &#9998;
              </button>
              <button
                onClick={() => { void handleDelete(entry.id); }}
                onMouseDown={(e) => e.stopPropagation()}
                title="Delete"
                style={actionButtonStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--danger-color)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                &#215;
              </button>
            </div>
          </div>
        ))}
      </div>
    </DockPanel>
  );
}
