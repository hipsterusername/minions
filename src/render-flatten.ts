/**
 * Flatten a dashboard's {@link RenderState} into a readable text block
 * so it can flow through the canvas context-protocol into a Leader.
 *
 * Pure function (no DOM, no React). Lives next to the canvas because the
 * server has no need for it — only the client wires render nodes into the
 * context-extraction pipeline.
 */
import type {
  RenderComponent,
  RenderState,
} from "../shared/render-dsl.ts";

/**
 * Serialize a render state to a markdown-ish text representation.
 * Returns an empty string when the dashboard has no components — callers
 * (extractContent) interpret that as "nothing to contribute."
 */
export function flattenRenderStateToText(state: RenderState): string {
  const { layout, components } = state;
  if (components.length === 0) return "";

  const parts: string[] = [];
  if (layout.title) parts.push(`# ${layout.title}`);
  for (const c of components) parts.push(formatComponent(c));
  return parts.join("\n\n");
}

function heading(title: string | undefined): string {
  return title ? `### ${title}\n` : "";
}

function formatComponent(c: RenderComponent): string {
  switch (c.type) {
    case "metric":
      return formatMetric(c);
    case "progress":
      return `**${c.label}**: ${c.value}%`;
    case "status":
      return `**${c.label}**: ${c.state}`;
    case "table":
      return formatTable(c);
    case "list":
      return formatList(c);
    case "text":
      return c.content;
    case "code":
      return `\`\`\`${c.language ?? ""}\n${c.content}\n\`\`\``;
    case "sparkline":
      return formatSparkline(c);
    case "kv":
      return formatKv(c);
    case "timeline":
      return formatTimeline(c);
    case "callout":
      return formatCallout(c);
    case "separator":
      return c.label ? `--- ${c.label} ---` : "---";
    case "diff":
      return formatDiff(c);
    case "checklist":
      return formatChecklist(c);
    case "tags":
      return formatTags(c);
  }
}

function formatMetric(c: Extract<RenderComponent, { type: "metric" }>): string {
  const trail: string[] = [];
  if (c.trend) trail.push(`(${c.trend})`);
  if (c.detail) trail.push(`— ${c.detail}`);
  const suffix = trail.length > 0 ? ` ${trail.join(" ")}` : "";
  return `**${c.label}**: ${c.value}${suffix}`;
}

function formatTable(c: Extract<RenderComponent, { type: "table" }>): string {
  const head = heading(c.title);
  const headerRow = `| ${c.headers.join(" | ")} |`;
  const sepRow = `| ${c.headers.map(() => "---").join(" | ")} |`;
  const dataRows = c.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${head}${headerRow}\n${sepRow}\n${dataRows}`;
}

function formatList(c: Extract<RenderComponent, { type: "list" }>): string {
  const head = heading(c.title);
  const items = c.items
    .map((it, i) => (c.ordered ? `${i + 1}. ${it}` : `- ${it}`))
    .join("\n");
  return `${head}${items}`;
}

function formatSparkline(
  c: Extract<RenderComponent, { type: "sparkline" }>,
): string {
  const label = c.label ?? "Sparkline";
  return `**${label}**: [${c.data.join(", ")}]`;
}

function formatKv(c: Extract<RenderComponent, { type: "kv" }>): string {
  const head = heading(c.title);
  const entries = c.entries.map((e) => `- ${e.key}: ${e.value}`).join("\n");
  return `${head}${entries}`;
}

function formatTimeline(
  c: Extract<RenderComponent, { type: "timeline" }>,
): string {
  const head = heading(c.title);
  const events = c.events
    .map((e) => {
      const segments: string[] = [];
      if (e.state) segments.push(`[${e.state}]`);
      if (e.time) segments.push(`(${e.time})`);
      segments.push(e.label);
      if (e.detail) segments.push(`— ${e.detail}`);
      return `- ${segments.join(" ")}`;
    })
    .join("\n");
  return `${head}${events}`;
}

function formatCallout(
  c: Extract<RenderComponent, { type: "callout" }>,
): string {
  const titleLine = c.title ? `**${c.title}**\n` : "";
  return `> [${c.variant.toUpperCase()}] ${titleLine}${c.content}`;
}

function formatDiff(c: Extract<RenderComponent, { type: "diff" }>): string {
  const head = heading(c.title);
  const beforeLabel = c.before.label ?? "Before";
  const afterLabel = c.after.label ?? "After";
  return (
    `${head}**${beforeLabel}:**\n` +
    `\`\`\`\n${c.before.content}\n\`\`\`\n\n` +
    `**${afterLabel}:**\n` +
    `\`\`\`\n${c.after.content}\n\`\`\``
  );
}

function formatChecklist(
  c: Extract<RenderComponent, { type: "checklist" }>,
): string {
  const head = heading(c.title);
  const items = c.items
    .map((i) => `- [${i.checked ? "x" : " "}] ${i.label}`)
    .join("\n");
  return `${head}${items}`;
}

function formatTags(c: Extract<RenderComponent, { type: "tags" }>): string {
  const prefix = c.label ? `**${c.label}**: ` : "";
  return `${prefix}${c.items.map((t) => t.text).join(", ")}`;
}
