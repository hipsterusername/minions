import { useState, type FormEvent } from "react";
import { isValidEmptyCanvasDescription } from "./empty-canvas.ts";

export function EmptyCanvasState({
  onStart,
  onAddLeader,
}: {
  onStart: (description: string) => void;
  onAddLeader: () => void;
}) {
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const canStart = isValidEmptyCanvasDescription(description);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (!canStart) return;
    onStart(description.trim());
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        padding: 24,
      }}
    >
      <form
        onSubmit={handleSubmit}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        style={{
          width: "min(560px, calc(100vw - 48px))",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: 18,
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          boxShadow: "var(--shadow-lg)",
          pointerEvents: "auto",
          fontFamily: "var(--font-sans)",
        }}
        aria-label="Start canvas with context"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 650,
              color: "var(--text-primary)",
              lineHeight: 1.3,
            }}
          >
            Start with context
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            Describe the project, goal, constraints, or current state before
            the Leader begins.
          </div>
        </div>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}
          >
            Context description
          </span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            rows={5}
            placeholder="Example: This repo is a canvas for coordinating agent work. I want to triage the next product improvements and keep a dashboard current."
            style={{
              width: "100%",
              resize: "vertical",
              minHeight: 112,
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              outline: "none",
              background: "var(--bg-primary)",
              color: "var(--text-primary)",
              padding: "10px 12px",
              fontSize: 13,
              lineHeight: "19px",
              fontFamily: "var(--font-sans)",
            }}
          />
        </label>

        {submitted && !canStart && (
          <div
            role="alert"
            style={{
              fontSize: 11,
              color: "var(--status-warning)",
              lineHeight: 1.4,
            }}
          >
            Add a bit more context before starting.
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.4,
            }}
          >
            The Leader will create and refresh the dashboard as it works.
          </span>
          <button
            type="submit"
            disabled={!canStart}
            style={{
              flexShrink: 0,
              padding: "8px 12px",
              borderRadius: 6,
              border: "none",
              background: canStart ? "var(--accent)" : "var(--bg-elevated)",
              color: canStart ? "#000" : "var(--text-muted)",
              cursor: canStart ? "pointer" : "default",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "var(--font-sans)",
            }}
          >
            Start Leader
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            paddingTop: 14,
            borderTop: "1px solid var(--border-default)",
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              lineHeight: 1.4,
            }}
          >
            Configure advanced settings before starting.
          </span>
          <button
            type="button"
            onClick={onAddLeader}
            style={{
              flexShrink: 0,
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid var(--border-default)",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
            }}
          >
            Add Leader node
          </button>
        </div>
      </form>
    </div>
  );
}
