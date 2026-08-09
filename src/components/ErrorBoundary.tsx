/**
 * ErrorBoundary — Catches rendering errors in any child tree and renders
 * a compact inline fallback so a single broken node can't kill the whole
 * canvas.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomeNodeComponent />
 *   </ErrorBoundary>
 *
 * Recommended integration points:
 *   - Wrap each canvas node renderer in `src/CanvasNode.tsx` where the
 *     per-node component is rendered (one boundary per node keeps the rest
 *     of the canvas alive when one node throws).
 *   - Optionally wrap the whole canvas content in `src/Canvas.tsx` as a
 *     top-level safety net.
 *
 * NOT wired into Canvas.tsx or any node file by this commit — the leader
 * or the user should integrate at the recommended sites above.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { browserLogger } from "../logging.ts";

const log = browserLogger.child("error-boundary");

interface Props {
  children: ReactNode;
  /** Optional label for the error header (e.g. the node type name). */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("render_failed", {
      error,
      componentStack: info.componentStack,
    });
  }

  handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { children, label } = this.props;

    if (!error) {
      return children;
    }

    const heading = label ? `${label} — render error` : "Render error";

    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "10px 12px",
          background: "var(--error-bg, #fef2f2)",
          border: "1px solid var(--status-error, #dc2626)",
          borderRadius: 6,
          fontSize: 12,
          color: "var(--text-primary, #111)",
          maxWidth: "100%",
          overflow: "hidden",
        }}
      >
        <strong style={{ color: "var(--status-error, #dc2626)" }}>{heading}</strong>
        <span
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 11,
            color: "var(--text-secondary, #555)",
            wordBreak: "break-all",
            whiteSpace: "pre-wrap",
          }}
        >
          {error.message}
        </span>
        <button
          type="button"
          onClick={this.handleReset}
          style={{
            alignSelf: "flex-start",
            marginTop: 4,
            padding: "3px 10px",
            fontSize: 11,
            cursor: "pointer",
            background: "var(--bg-secondary, #f4f4f5)",
            border: "1px solid var(--border-default, #d4d4d8)",
            borderRadius: 4,
            color: "var(--text-primary, #111)",
          }}
        >
          Retry
        </button>
      </div>
    );
  }
}
