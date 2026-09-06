import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePersistDb, openPersistDb } from "./session-persist.ts";
import { SessionHost } from "./session-host.ts";
import { upsertRenderState } from "./session-repo.ts";
import { buildPriorDashboardContext } from "./work-item-dashboard-context.ts";

beforeEach(() => {
  const db = openPersistDb(":memory:");
  new SessionHost("prior", "/tmp").persist();
  db.prepare(`UPDATE sessions SET run_outcome = 'completed', ended_at = 1000,
    dashboard_revision = 2, final_dashboard_revision = 2 WHERE session_key = 'prior'`).run();
  upsertRenderState(db, "prior", { layout: { title: "API migration", columns: 2, gap: 12 },
    components: [{ id: "checks", type: "status", label: "Compatibility tests", state: "success" }] });
});
afterEach(() => closePersistDb());

describe("prior dashboard context", () => {
  it("includes a finalized snapshot with its source and limits on its authority", () => {
    const result = buildPriorDashboardContext(openPersistDb(), "prior");
    expect(result).toContain("Source run: prior. Dashboard revision: 2.");
    expect(result).toContain('"id": "checks"');
    expect(result).toContain("Compatibility tests");
    expect(result).toContain("historical display context");
    expect(result).toContain("Old forms are not pending decisions");
    expect(result).toMatch(/<\/prior-dashboard-context>$/);
  });

  it.each([
    "UPDATE sessions SET dashboard_revision = 3",
    "UPDATE sessions SET final_dashboard_revision = NULL",
    "UPDATE sessions SET dashboard_revision = 0, final_dashboard_revision = 0",
    "UPDATE sessions SET run_outcome = 'interrupted'",
    "UPDATE sessions SET ended_at = NULL",
    "DELETE FROM render_state",
    "UPDATE render_state SET components = '[]'",
    "UPDATE render_state SET components = 'invalid json'",
  ])("omits unverified or unavailable dashboard state: %s", (sql) => {
    const db = openPersistDb();
    db.prepare(sql).run();
    expect(buildPriorDashboardContext(db, "prior")).toBe("");
  });

  it("does not fall back to another run's dashboard", () => {
    expect(buildPriorDashboardContext(openPersistDb(), "other-run")).toBe("");
  });

  it("bounds large dashboards and strips embedded media even in nested components", () => {
    const db = openPersistDb();
    upsertRenderState(db, "prior", { layout: { title: "Large dashboard", columns: 2, gap: 12 },
      components: [{ id: "nested", type: "section", title: "Artifacts", components: [
        { id: "image", type: "image", src: "data:image/png;base64,MEDIA_SENTINEL", alt: "Screenshot" },
        { id: "html", type: "html-artifact", html: "HTML_SENTINEL", title: "Preview" },
      ] }, ...Array.from({ length: 100 }, (_, i) => ({ id: `text-${i}`, type: "text" as const, content: "x".repeat(2000) }))] });
    const result = buildPriorDashboardContext(db, "prior");
    expect(result).toContain("Screenshot");
    expect(result).not.toContain("MEDIA_SENTINEL");
    expect(result).not.toContain("HTML_SENTINEL");
    expect(result).toContain("omitted by handoff budget");
    expect(result.length).toBeLessThan(7_000);
    expect(result).toMatch(/<\/prior-dashboard-context>$/);
  });
});
