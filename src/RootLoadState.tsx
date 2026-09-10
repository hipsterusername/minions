import { Component, type ErrorInfo, type ReactNode } from "react";

const shellStyle = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "var(--bg-primary, #0a0e1a)",
  color: "var(--text-primary, #e6ecf5)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  textAlign: "center",
} as const;

export function RootLoadingScreen() {
  return (
    <div role="status" aria-live="polite" style={shellStyle}>
      <div>
        <strong style={{ display: "block", fontSize: 18 }}>Minions</strong>
        <span style={{ display: "block", marginTop: 8, color: "var(--text-secondary, #aab3c5)" }}>
          Loading workspace…
        </span>
      </div>
    </div>
  );
}

interface RootErrorBoundaryState {
  error: Error | null;
}

export class RootErrorBoundary extends Component<
  { children: ReactNode },
  RootErrorBoundaryState
> {
  override state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Minions failed to load", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main role="alert" style={shellStyle}>
        <div style={{ maxWidth: 360 }}>
          <strong style={{ display: "block", fontSize: 18 }}>Minions couldn’t load</strong>
          <p style={{ margin: "10px 0 18px", color: "var(--text-secondary, #aab3c5)", lineHeight: 1.5 }}>
            The app files may have changed while this page was open. Reload to get the latest version.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              minHeight: 44,
              padding: "0 18px",
              border: "1px solid var(--border-default, #313a5a)",
              borderRadius: 8,
              background: "var(--accent, #f59e3b)",
              color: "var(--text-on-accent, #0a0e1a)",
              font: "inherit",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </main>
    );
  }
}
