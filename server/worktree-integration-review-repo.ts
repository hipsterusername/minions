import type Database from "better-sqlite3";
import type { ContributionRow, LineageRow } from "./worktree-integration-repo.ts";
const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);
const contribution = (db: Database.Database, id: string) => db.prepare(
  "SELECT * FROM worktree_contributions WHERE id=?").get(id) as ContributionRow | undefined;
const lineage = (db: Database.Database, id: string) => db.prepare(
  "SELECT * FROM worktree_lineages WHERE id=?").get(id) as LineageRow | undefined;
function audit(db: Database.Database, input: { lineageId: string; contributionId?: string;
  event: string; actor?: string; details?: unknown; at: number }) {
  db.prepare(`INSERT INTO worktree_integration_audit
    (lineage_id,contribution_id,event,actor,details,recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.lineageId, input.contributionId ?? null, input.event, input.actor ?? null,
      json(input.details), input.at);
}
export function recordGate(db: Database.Database, input: { id: string; contributionId: string;
  name: string; status: "pending" | "passed" | "failed" | "waived"; details?: unknown; at: number }): void {
  db.transaction(() => { const row = contribution(db, input.contributionId); if (!row) throw new Error("contribution not found");
    const prior = db.prepare(`SELECT id FROM worktree_integration_gates WHERE scope='contribution'
      AND contribution_id=? AND name=?`).get(row.id, input.name) as { id: string } | undefined;
    if (prior) db.prepare("UPDATE worktree_integration_gates SET status=?,details=?,recorded_at=? WHERE id=?")
      .run(input.status, json(input.details), input.at, prior.id);
    else db.prepare(`INSERT INTO worktree_integration_gates
      (id,lineage_id,contribution_id,scope,name,status,details,recorded_at)
      VALUES (?, ?, ?, 'contribution', ?, ?, ?, ?)`).run(input.id, row.lineage_id, row.id,
        input.name, input.status, json(input.details), input.at);
    db.prepare("UPDATE worktree_contributions SET revision=revision+1,updated_at=? WHERE id=?").run(input.at, row.id);
    audit(db, { lineageId: row.lineage_id, contributionId: row.id, event: "gate_recorded",
      details: { name: input.name, status: input.status }, at: input.at }); }).immediate();
}
export function recordLineageGate(db: Database.Database, input: { id: string; lineageId: string;
  name: string; status: "pending" | "passed" | "failed" | "waived"; details?: unknown; at: number }): void {
  db.transaction(() => { const row = lineage(db, input.lineageId); if (!row) throw new Error("lineage not found");
    const prior = db.prepare(`SELECT id FROM worktree_integration_gates WHERE scope='lineage'
      AND lineage_id=? AND name=?`).get(row.id, input.name) as { id: string } | undefined;
    if (prior) db.prepare("UPDATE worktree_integration_gates SET status=?,details=?,recorded_at=? WHERE id=?")
      .run(input.status, json(input.details), input.at, prior.id);
    else db.prepare(`INSERT INTO worktree_integration_gates
      (id,lineage_id,contribution_id,scope,name,status,details,recorded_at)
      VALUES (?, ?, NULL, 'lineage', ?, ?, ?, ?)`).run(input.id, row.id,
        input.name, input.status, json(input.details), input.at);
    db.prepare("UPDATE worktree_lineages SET revision=revision+1,updated_at=? WHERE id=?").run(input.at, row.id);
    audit(db, { lineageId: row.id, event: "lineage_gate_recorded",
      details: { name: input.name, status: input.status }, at: input.at }); }).immediate();
}
export function recordContributionReview(db: Database.Database, input: { id: string; contributionId: string;
  expectedRevision: number; decision: "approved" | "rejected"; actor: string; notes?: string; at: number }): ContributionRow {
  return db.transaction(() => { const row = contribution(db, input.contributionId);
    if (!row || row.revision !== input.expectedRevision) throw new Error("contribution revision required");
    if (row.state !== "ready" || !row.head_sha) throw new Error("ready contribution head required for review");
    db.prepare(`INSERT INTO worktree_integration_reviews
      (id,lineage_id,contribution_id,scope,decision,actor,notes,reviewed_head_sha,recorded_at)
      VALUES (?, ?, ?, 'contribution', ?, ?, ?, ?, ?)`).run(input.id, row.lineage_id, row.id,
        input.decision, input.actor, input.notes ?? null, row.head_sha, input.at);
    db.prepare("UPDATE worktree_contributions SET review_state=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(input.decision, input.at, row.id);
    audit(db, { lineageId: row.lineage_id, contributionId: row.id, event: "contribution_reviewed",
      actor: input.actor, details: { decision: input.decision }, at: input.at }); return contribution(db, row.id)!; }).immediate();
}
export function recordLineageApproval(db: Database.Database, input: { id: string; lineageId: string;
  expectedRevision: number; decision: "approved" | "rejected"; actor: string; notes?: string; at: number }): void {
  db.transaction(() => { const row = lineage(db, input.lineageId); if (!row) throw new Error("lineage not found");
    if (row.revision !== input.expectedRevision) throw new Error("stale lineage revision");
    if (row.status !== "open" || row.integration_state !== "active") throw new Error("active open lineage required for final review");
    if (input.decision === "approved") {
      if (!db.prepare("SELECT 1 FROM worktree_contributions WHERE lineage_id=? AND state='integrated' LIMIT 1").get(row.id))
        throw new Error("at least one integrated contribution required");
      if (db.prepare("SELECT 1 FROM worktree_contributions WHERE lineage_id=? AND state NOT IN ('integrated','discarded') LIMIT 1").get(row.id))
        throw new Error("all contributions must be integrated or discarded before final approval");
      if (db.prepare("SELECT 1 FROM worktree_integration_gates WHERE lineage_id=? AND scope='lineage' AND name<>'promotion_runtime' AND status NOT IN ('passed','waived') LIMIT 1").get(row.id))
        throw new Error("lineage gates must pass before final approval"); }
    const head = row.integration_head_sha ?? row.base_sha;
    db.prepare(`INSERT INTO worktree_integration_reviews
      (id,lineage_id,contribution_id,scope,decision,actor,notes,reviewed_head_sha,recorded_at)
      VALUES (?, ?, NULL, 'lineage', ?, ?, ?, ?, ?)`).run(input.id, row.id,
        input.decision, input.actor, input.notes ?? null, head, input.at);
    db.prepare("UPDATE worktree_lineages SET revision=revision+1,updated_at=? WHERE id=?").run(input.at, row.id);
    audit(db, { lineageId: row.id, event: "lineage_reviewed", actor: input.actor,
      details: { decision: input.decision }, at: input.at }); }).immediate();
}
