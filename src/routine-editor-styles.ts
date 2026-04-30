/**
 * Shared inline-style constants for the Routine editor surfaces.
 *
 * Styles are inline objects to match the rest of the codebase. Any cross-
 * surface visual constant lives here so the rail / overview / phase / step
 * workspaces stay in lock step.
 */
import type { CSSProperties } from "react";

// ── Inputs / forms ──────────────────────────────────────────────────────────

export const labelSt: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--text-secondary)",
  marginBottom: 4,
  fontFamily: "var(--font-sans)",
};

export const inputSt: CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

export const fieldErrSt: CSSProperties = {
  color: "var(--danger-color)",
  fontSize: 11,
  marginTop: 2,
};

// ── Buttons ─────────────────────────────────────────────────────────────────

export const btnBase: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-default)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
};

export const addBtnSt: CSSProperties = {
  ...btnBase,
  background: "none",
  color: "var(--text-secondary)",
  border: "1px dashed var(--border-default)",
  fontSize: 12,
};

// ── Cards / sections ────────────────────────────────────────────────────────

export const cardSt: CSSProperties = {
  padding: 14,
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
};

export const sectionSt: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

// ── Eyebrows / headings ─────────────────────────────────────────────────────

export const eyebrowSt: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-muted)",
};

export const titleSt: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.01em",
  color: "var(--text-primary)",
  lineHeight: 1.2,
};

export const subtitleSt: CSSProperties = {
  fontSize: 13,
  color: "var(--text-secondary)",
  marginTop: 4,
  lineHeight: 1.5,
};

export const subHeaderSt: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

export const subTitleSt: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-secondary)",
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

export const subTitleHintSt: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--text-muted)",
};

// ── ID reference rows (de-emphasised id input) ──────────────────────────────

export const refRowSt: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 10,
  fontSize: 11,
  color: "var(--text-muted)",
};

export const refLabelSt: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

export const refCodeSt: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-secondary)",
  background: "var(--code-bg, var(--bg-elevated))",
  padding: "2px 6px",
  borderRadius: 4,
};

export const refInputSt: CSSProperties = {
  flex: 1,
  maxWidth: 200,
  padding: "3px 8px",
  background: "transparent",
  border: "1px dashed var(--border-default)",
  borderRadius: 4,
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  outline: "none",
};

// ── Empty states ────────────────────────────────────────────────────────────

export const emptyStateSt: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  padding: "8px 0",
  fontStyle: "italic",
};
