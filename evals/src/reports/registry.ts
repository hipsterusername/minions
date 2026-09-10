import type { ReportView } from "../core/contracts.js";

/** Explicit local registry for offline report renderers; duplicate IDs are rejected. */
export class ReportViewRegistry {
  private readonly views = new Map<string, ReportView>();
  register(view: ReportView): void { if (this.views.has(view.id)) throw new Error(`report view already registered: ${view.id}`); this.views.set(view.id, view); }
  get(id: string): ReportView { const view = this.views.get(id); if (!view) throw new Error(`unknown report view: ${id}`); return view; }
  list(): readonly ReportView[] { return [...this.views.values()]; }
}

import { renderOfflineReport } from "./html.js";
import type { ReportRecord } from "./aggregation.js";
/** Built-in renderer registered through the same extension contract as custom views. */
export function createReportViewRegistry(): ReportViewRegistry {
  const registry = new ReportViewRegistry();
  registry.register({id:"offline",version:"2",async render(input) {
    for (const row of input.results) if (!row || typeof row !== "object" || !("result" in row) || !("task" in row) || !("mode" in row)) throw new Error("offline view requires ReportRecord inputs");
    return {html:renderOfflineReport(input.results as ReportRecord[],input.metrics),warnings:[]};
  }});
  return registry;
}
