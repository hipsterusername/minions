import { memo, useMemo } from "react";
import { agentFieldLabel, agentJsonText, parseAgentJson, type AgentJson } from "../agent-message-format.ts";
import { SimpleMarkdown } from "./SimpleMarkdown.tsx";

// Display only: keep the original report intact for graph verdicts and copying.
// Reports can have longer summaries than the persisted verdict schema allows.
function verificationReport(value: AgentJson) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { result, confidence, summary, ...extra } = value;
  if (result !== "passed" && result !== "failed" && result !== "inconclusive") return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (summary !== undefined && (typeof summary !== "string" || !summary.trim())) return null;
  return { result, confidence, body: { ...(summary === undefined ? {} : { summary }), ...extra } } as const;
}

const labels = { passed: "Passed", failed: "Failed", inconclusive: "Inconclusive" };

function preview(text: string, maxLength: number | undefined): string {
  return maxLength !== undefined && text.length > maxLength
    ? `${text.slice(0, maxLength).trimEnd()}...`
    : text;
}

export const AgentMessageText = memo(function AgentMessageText({ text, maxLength }: {
  text: string;
  maxLength?: number | undefined;
}) {
  const parsed = useMemo(() => parseAgentJson(text), [text]);
  if (!parsed) return <SimpleMarkdown text={preview(text, maxLength)} />;
  if (parsed.value === null || typeof parsed.value !== "object") {
    return <JsonContent value={parsed.value} depth={0} maxLength={maxLength} />;
  }
  // Operational evidence is an attachment-like disclosure, not the chat body.
  // Once opened, show the complete report even on surfaces with clipped previews.
  return <details style={{ whiteSpace: "normal", minWidth: 0 }}>
    <summary
      style={{ cursor: "pointer", color: "var(--accent)", fontWeight: 600 }}
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >View report details</summary>
    <div style={{ marginTop: 8 }}><JsonContent value={parsed.value} depth={0} /></div>
  </details>;
});

function JsonContent({ value, depth, maxLength }: { value: AgentJson; depth: number; maxLength?: number | undefined }) {
  const report = verificationReport(value);
  if (!report) return <JsonFields value={value} depth={depth} maxLength={maxLength} />;

  return (
    <div aria-label="Verification result">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "baseline", marginBottom: 4 }}>
        <strong style={{ color: report.result === "passed" ? "var(--success-color)" : "var(--warning-color)" }}>
          Verification: {labels[report.result]}
        </strong>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.9em" }}>
          Confidence: {Number((report.confidence * 100).toFixed(2))}%
        </span>
      </div>
      {Object.keys(report.body).length > 0 && <div style={{ color: "var(--text-primary)" }}>
        <JsonFields value={report.body} depth={depth} maxLength={maxLength} />
      </div>}
    </div>
  );
}

function JsonFields({ value, depth, maxLength }: { value: AgentJson; depth: number; maxLength?: number | undefined }) {
  if (maxLength !== undefined) return <SimpleMarkdown text={preview(agentJsonText(value), maxLength)} />;
  // Bound nested UI expansion; retain deeper or very wide data as readable JSON.
  if (depth >= 6 || (value && typeof value === "object" && Object.keys(value).length > 100)) {
    return <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === "string") {
    const nested = parseAgentJson(value);
    return nested ? <JsonContent value={nested.value} depth={depth + 1} /> : <SimpleMarkdown text={value || '""'} />;
  }
  if (value === null || typeof value !== "object") return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    return value.length ? <ol style={{ margin: "4px 0", paddingLeft: 22 }}>
      {value.map((item, index) => <li key={index}><JsonContent value={item} depth={depth + 1} /></li>)}
    </ol> : <span>[]</span>;
  }
  const fields = Object.entries(value);
  return fields.length ? <dl style={{ margin: 0, overflowWrap: "anywhere" }}>
    {fields.map(([key, item]) => <div key={key} style={{ marginBottom: 6 }}>
      <dt style={{ fontWeight: 600, color: "var(--text-primary)" }}>{agentFieldLabel(key)}</dt>
      <dd style={{ margin: "2px 0 0 8px", color: "var(--text-primary)" }}><JsonContent value={item} depth={depth + 1} /></dd>
    </div>)}
  </dl> : <span>{"{}"}</span>;
}
