import { useState, useEffect, useCallback } from "react";
import {
  getProjectContext,
  updateProjectContext,
  type ProjectContext,
  type ProjectSettings,
} from "./api.ts";

interface ProjectPanelProps {
  projectId: string;
  projectPath: string;
  projectName: string;
  settings: ProjectSettings;
  onSpawnContextExplorer: () => void;
}

export function ProjectPanel({
  projectId,
  projectPath,
  projectName,
  settings,
  onSpawnContextExplorer,
}: ProjectPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"context" | "settings">("context");

  // Load context on mount
  useEffect(() => {
    void (async () => {
      try {
        const ctx = await getProjectContext(projectId);
        setContext(ctx);
      } catch (err) {
        console.error("Failed to load context:", err);
      }
    })();
  }, [projectId]);

  const handleEditStart = useCallback(() => {
    setEditBuffer(context?.content ?? "");
    setEditing(true);
  }, [context]);

  const handleEditSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateProjectContext(projectId, editBuffer);
      setContext({ content: editBuffer, exists: true });
      setEditing(false);
    } catch (err) {
      console.error("Failed to save context:", err);
    } finally {
      setSaving(false);
    }
  }, [projectId, editBuffer]);

  const handleEditCancel = useCallback(() => {
    setEditing(false);
    setEditBuffer("");
  }, []);

  const contextIsEmpty =
    !context?.exists ||
    !context.content.trim() ||
    context.content.includes("Project context has not been configured yet.");

  if (collapsed) {
    return (
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 16,
          zIndex: 100,
        }}
      >
        <button
          onClick={() => setCollapsed(false)}
          style={{
            padding: "8px 12px",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <span style={{ fontSize: 14 }}>&#9776;</span>
          {projectName}
          {contextIsEmpty && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#facc15",
                flexShrink: 0,
              }}
            />
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 16,
        width: 340,
        maxHeight: "calc(100% - 80px)",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
          background: "linear-gradient(135deg, #1a1040 0%, var(--bg-secondary) 100%)",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {projectName}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 240,
            }}
          >
            {projectPath}
          </div>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          &#x2715;
        </button>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        {(["context", "settings"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: "8px 0",
              fontSize: 11,
              fontWeight: 500,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              background: "transparent",
              border: "none",
              borderBottom: activeTab === tab ? "2px solid var(--accent)" : "2px solid transparent",
              color: activeTab === tab ? "var(--text-primary)" : "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 14px",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {activeTab === "context" && (
          <>
            {/* Empty state with Generate button */}
            {contextIsEmpty && !editing && (
              <div
                style={{
                  textAlign: "center",
                  padding: "24px 12px",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-muted)",
                    marginBottom: 16,
                    lineHeight: 1.5,
                  }}
                >
                  No project context configured yet. Write it yourself or let a Leader agent explore and populate it.
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  <button
                    onClick={handleEditStart}
                    style={{
                      padding: "8px 16px",
                      fontSize: 12,
                      fontWeight: 500,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 6,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    Write Manually
                  </button>
                  <button
                    onClick={onSpawnContextExplorer}
                    style={{
                      padding: "8px 16px",
                      fontSize: 12,
                      fontWeight: 500,
                      background: "linear-gradient(135deg, #818cf8, #6366f1)",
                      border: "none",
                      borderRadius: 6,
                      color: "#fff",
                      cursor: "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    Generate with AI
                  </button>
                </div>
              </div>
            )}

            {/* Editing mode */}
            {editing && (
              <div>
                <textarea
                  value={editBuffer}
                  onChange={(e) => setEditBuffer(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: 200,
                    padding: "10px 12px",
                    fontSize: 12,
                    lineHeight: 1.6,
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 6,
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                    resize: "vertical",
                    outline: "none",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
                />
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginTop: 8,
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    onClick={handleEditCancel}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      background: "transparent",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleEditSave()}
                    disabled={saving}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      background: "var(--accent)",
                      border: "none",
                      borderRadius: 4,
                      color: "#fff",
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            )}

            {/* Display mode (context populated) */}
            {!contextIsEmpty && !editing && (
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginBottom: 8,
                    gap: 6,
                  }}
                >
                  <button
                    onClick={handleEditStart}
                    style={{
                      padding: "4px 10px",
                      fontSize: 10,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={onSpawnContextExplorer}
                    style={{
                      padding: "4px 10px",
                      fontSize: 10,
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Regenerate
                  </button>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-sans)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {context?.content}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === "settings" && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 4,
                }}
              >
                Default Model
              </label>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  padding: "6px 10px",
                  background: "var(--bg-primary)",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {settings.defaultModel ?? "sonnet"}
              </div>
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 4,
                }}
              >
                Default Permission Mode
              </label>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  padding: "6px 10px",
                  background: "var(--bg-primary)",
                  borderRadius: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {settings.defaultPermissionMode ?? "bypassPermissions"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
