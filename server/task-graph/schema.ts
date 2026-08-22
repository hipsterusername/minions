import type Database from "better-sqlite3";

export function migrateTaskGraph(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_graph_definitions (
      id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_graph_revisions (
      id TEXT PRIMARY KEY, definition_id TEXT NOT NULL REFERENCES task_graph_definitions(id),
      spec_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_graph_nodes (
      revision_id TEXT NOT NULL REFERENCES task_graph_revisions(id), id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, spec_json TEXT NOT NULL, PRIMARY KEY(revision_id,id)
    );
    CREATE TABLE IF NOT EXISTS task_graph_edges (
      revision_id TEXT NOT NULL REFERENCES task_graph_revisions(id), id TEXT NOT NULL,
      source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, spec_json TEXT NOT NULL,
      PRIMARY KEY(revision_id,id)
    );
    CREATE TABLE IF NOT EXISTS task_source_snapshots (
      id TEXT PRIMARY KEY, run_key TEXT NOT NULL, revision_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      content_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_graph_runs (
      id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, primary_run_key TEXT NOT NULL,
      revision_id TEXT NOT NULL REFERENCES task_graph_revisions(id), source_snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      max_active_attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_node_attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_graph_runs(id), node_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL, generation INTEGER NOT NULL, source_snapshot_id TEXT NOT NULL,
      runtime TEXT NOT NULL, outcome TEXT NOT NULL, session_run_key TEXT, progress_seq INTEGER NOT NULL DEFAULT 0,
      backoff_until INTEGER, terminal_witness_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(run_id,node_id,attempt_number), UNIQUE(run_id,node_id,generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_current_attempt ON task_node_attempts(run_id,node_id)
      WHERE runtime <> 'terminal';
    CREATE TABLE IF NOT EXISTS task_resource_reservations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL,
      amount INTEGER NOT NULL, fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_manual_retry_grants (
      run_id TEXT NOT NULL, node_id TEXT NOT NULL, remaining INTEGER NOT NULL,
      granted_at INTEGER NOT NULL, PRIMARY KEY(run_id,node_id)
    );
    CREATE TABLE IF NOT EXISTS task_scheduler_leases (
      run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_scheduler_outbox (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL, delivered_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, producer_attempt_id TEXT NOT NULL,
      source_snapshot_id TEXT NOT NULL, output_name TEXT NOT NULL, content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, committed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_one_attempt_output
      ON task_artifacts(run_id,producer_attempt_id,output_name);
    CREATE TABLE IF NOT EXISTS task_verifications (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, producer_attempt_id TEXT NOT NULL,
      verifier_attempt_id TEXT NOT NULL, source_snapshot_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result TEXT NOT NULL, record_json TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_verification_requests (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
      producer_attempt_id TEXT NOT NULL, verifier_attempt_id TEXT NOT NULL UNIQUE,
      verifier_run_key TEXT, status TEXT NOT NULL, result TEXT,
      launch_attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    DROP INDEX IF EXISTS task_one_active_verification_request;
    CREATE UNIQUE INDEX task_one_active_verification_request
      ON task_verification_requests(run_id,node_id)
      WHERE status IN ('pending','launching','running');
    CREATE TABLE IF NOT EXISTS task_human_inputs (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
      edge_ids_json TEXT NOT NULL, actor TEXT NOT NULL, content_hash TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_edge_evaluations (
      run_id TEXT NOT NULL, edge_id TEXT NOT NULL, satisfied INTEGER NOT NULL, reason TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL, run_revision INTEGER NOT NULL, evaluated_at INTEGER NOT NULL,
      PRIMARY KEY(run_id,edge_id)
    );
    CREATE TABLE IF NOT EXISTS task_frozen_joins (
      run_id TEXT NOT NULL, node_id TEXT NOT NULL, policy TEXT NOT NULL, quorum INTEGER,
      cohort_json TEXT NOT NULL, frozen_at INTEGER NOT NULL, PRIMARY KEY(run_id,node_id)
    );
    CREATE TABLE IF NOT EXISTS task_expansion_instances (
      run_id TEXT NOT NULL, expansion_node_id TEXT NOT NULL, instance_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, input_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(run_id,expansion_node_id,instance_id),
      UNIQUE(run_id,expansion_node_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS task_reductions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reducer_node_id TEXT NOT NULL,
      expansion_node_id TEXT NOT NULL, input_fingerprint TEXT NOT NULL, output_hash TEXT NOT NULL,
      instance_count INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_reconciliations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_graph_steering_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, instructions_hash TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_node_invalidations (
      run_id TEXT NOT NULL, node_id TEXT NOT NULL, steering_id TEXT NOT NULL,
      invalidated_attempt_id TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY(run_id,node_id,steering_id),
      FOREIGN KEY(steering_id) REFERENCES task_graph_steering_events(id)
    );
    CREATE INDEX IF NOT EXISTS task_node_invalidations_latest
      ON task_node_invalidations(run_id,node_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS task_node_adjudications (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, source_snapshot_id TEXT NOT NULL,
      acceptance_criteria_version TEXT NOT NULL, decision TEXT NOT NULL,
      actor TEXT NOT NULL, reason TEXT NOT NULL, guidance TEXT, created_at INTEGER NOT NULL,
      UNIQUE(run_id,node_id,attempt_id)
    );
    CREATE INDEX IF NOT EXISTS task_node_adjudications_run
      ON task_node_adjudications(run_id,node_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS task_scheduler_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, run_revision INTEGER NOT NULL,
      type TEXT NOT NULL, object_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(run_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS task_events_run ON task_scheduler_events(run_id,sequence);
    CREATE TABLE IF NOT EXISTS task_graph_plan_proposals (
      id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, primary_run_key TEXT NOT NULL,
      proposal_revision INTEGER NOT NULL, projection_revision INTEGER NOT NULL,
      base_proposal_revision INTEGER, state TEXT NOT NULL, mode TEXT NOT NULL,
      request_id TEXT NOT NULL, request_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
      node_ids_json TEXT NOT NULL, graph_revision_id TEXT, graph_run_id TEXT,
      source_snapshot_json TEXT, source_fingerprint TEXT,
      auto_start_eligible INTEGER NOT NULL DEFAULT 0, error TEXT,
      start_blocked_reason TEXT,
      review_requirements_json TEXT NOT NULL DEFAULT '[]',
      terminal_wake_delivered_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(work_item_id,primary_run_key,proposal_revision),
      UNIQUE(work_item_id,primary_run_key,request_id)
    );
    CREATE INDEX IF NOT EXISTS task_graph_plan_latest
      ON task_graph_plan_proposals(work_item_id,primary_run_key,proposal_revision DESC);
    CREATE TABLE IF NOT EXISTS task_graph_context_sources (
      source_snapshot_id TEXT NOT NULL, node_id TEXT NOT NULL, source_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, classification TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(source_snapshot_id,node_id,source_id)
    );
  `);
  ensureColumn(db,"task_verification_requests","launch_attempts","INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db,"task_verification_requests","next_retry_at","INTEGER");
  ensureColumn(db,"task_graph_plan_proposals","start_blocked_reason","TEXT");
  ensureColumn(db,"task_graph_plan_proposals","review_requirements_json",
    "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db,"task_graph_plan_proposals","terminal_wake_delivered_at","INTEGER");
  migrateLegacyGraphRunUniqueness(db);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS task_one_nonterminal_graph_run
    ON task_graph_runs(work_item_id,primary_run_key)
    WHERE status NOT IN ('completed','failed','cancelled')`);
  migrateLegacyPendingReviewBlockers(db);
}

/**
 * Early task-graph databases encoded "one graph ever" as a table UNIQUE constraint.
 * Rebuild only that legacy shape so history can contain many terminal iterations while
 * the partial index above continues to enforce one nonterminal graph transactionally.
 */
function migrateLegacyGraphRunUniqueness(db:Database.Database):void {
  const table=db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='table' AND name='task_graph_runs'`).get() as {sql:string}|undefined;
  if (!table?.sql || !/UNIQUE\s*\(\s*work_item_id\s*,\s*primary_run_key\s*\)/i.test(table.sql)) {
    return;
  }
  const objects=db.prepare(`SELECT name,sql FROM sqlite_master
    WHERE tbl_name='task_graph_runs' AND type IN ('index','trigger') AND sql IS NOT NULL
    ORDER BY type,name`).all() as Array<{name:string;sql:string}>;
  const columns=(db.pragma("table_info(task_graph_runs)") as Array<{name:string}>)
    .map(row=>`"${row.name.replaceAll('"','""')}"`).join(", ");
  const createSql=table.sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"task_graph_runs"|`task_graph_runs`|\[task_graph_runs\]|task_graph_runs)/i,
      "CREATE TABLE task_graph_runs_iteration_migration")
    .replace(/,\s*UNIQUE\s*\(\s*work_item_id\s*,\s*primary_run_key\s*\)/i,"");
  const foreignKeys=db.pragma("foreign_keys",{simple:true}) as number;
  if (foreignKeys) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(()=>{
      db.exec(createSql);
      db.exec(`INSERT INTO task_graph_runs_iteration_migration (${columns})
        SELECT ${columns} FROM task_graph_runs`);
      db.exec("DROP TABLE task_graph_runs");
      db.exec("ALTER TABLE task_graph_runs_iteration_migration RENAME TO task_graph_runs");
      for (const object of objects) db.exec(object.sql);
    }).immediate();
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
}

function migrateLegacyPendingReviewBlockers(db: Database.Database): void {
  const rows = db.prepare(`SELECT id,start_blocked_reason FROM task_graph_plan_proposals
    WHERE state='ready' AND start_blocked_reason LIKE
      'Work Packet gate % is required_pending.'`).all() as Array<{
    id: string;
    start_blocked_reason: string;
  }>;
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE task_graph_plan_proposals
    SET start_blocked_reason=NULL,
      error=CASE WHEN error=? THEN NULL ELSE error END,
      review_requirements_json=?
    WHERE id=? AND start_blocked_reason=?`);
  db.transaction(() => {
    for (const row of rows) {
      const name = row.start_blocked_reason
        .match(/^Work Packet gate (.+) is required_pending\.$/)?.[1] ?? "Work Packet review";
      const gateId = `legacy.${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.|\.$/g, "") || "review"}`;
      const requirements = [{ gateId, name,
        reason: "Pending review captured before graph-start gate separation." }];
      update.run(row.start_blocked_reason, JSON.stringify(requirements), row.id,
        row.start_blocked_reason);
    }
  }).immediate();
}

function ensureColumn(db:Database.Database,table:string,column:string,declaration:string): void {
  const columns=db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;
  if (!columns.some(candidate=>candidate.name===column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}
