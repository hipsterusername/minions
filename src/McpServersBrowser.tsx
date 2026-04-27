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
    const args = d.args
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
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

function McpServerForm({
  draft,
  isNew,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
}: FormProps) {
  const field = (key: keyof DraftEntry) => ({
    value: draft[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange({ ...draft, [key]: e.target.value }),
    style: inputStyle,
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  });

  return (
    <div
      style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 2 }}>
        {isNew ? "Add MCP Server" : "Edit MCP Server"}
      </div>

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
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface McpServersBrowserProps {
  projectId: string;
  refreshKey?: number;
}

export function McpServersBrowser({ projectId, refreshKey }: McpServersBrowserProps) {
  const [collapsed, setCollapsed] = useState(true);
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
    if (!collapsed) load();
  }, [collapsed, load, refreshKey]);

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

  // ── Collapsed button ──

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          bottom: 56,
          right: 16,
          zIndex: 100,
          padding: "8px 12px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          color: "var(--text-secondary)",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          boxShadow: "var(--shadow-md)",
        }}
      >
        <span style={{ fontSize: 14 }}>&#x1F50C;</span>
        MCP
        {entries.length > 0 && (
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              background: "var(--bg-primary)",
              padding: "1px 5px",
              borderRadius: 8,
            }}
          >
            {entries.length}
          </span>
        )}
      </button>
    );
  }

  // ── Expanded panel ──

  return (
    <div
      style={{
        position: "absolute",
        bottom: 56,
        right: 16,
        zIndex: 100,
        width: 320,
        maxHeight: "calc(100% - 120px)",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 1,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 14 }}>&#x1F50C;</span>
          MCP Servers ({entries.length})
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            onClick={openNew}
            onMouseDown={(e) => e.stopPropagation()}
            title="Add MCP Server"
            style={actionButtonStyle}
          >
            +
          </button>
          <button
            onClick={() => { setShowForm(false); setCollapsed(true); }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{ ...actionButtonStyle, fontSize: 14, padding: "0 4px" }}
          >
            &#9654;
          </button>
        </div>
      </div>

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
    </div>
  );
}
