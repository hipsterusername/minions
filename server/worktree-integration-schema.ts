import type Database from "better-sqlite3";

export function ensureWorktreeIntegrationSchema(db: Database.Database): void {
  const hasTable = (name: string) => Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const addColumn = (table: string, name: string, sql: string) => {
    if (!hasTable(table)) return;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
  };
  addColumn("worktree_lineages", "project_id", "project_id TEXT NOT NULL DEFAULT ''");
  addColumn("worktree_lineages", "integration_ref", "integration_ref TEXT NOT NULL DEFAULT ''");
  addColumn("worktree_lineages", "integration_worktree_path", "integration_worktree_path TEXT NOT NULL DEFAULT ''");
  addColumn("worktree_lineages", "integration_head_sha", "integration_head_sha TEXT");
  addColumn("worktree_lineages", "revision", "revision INTEGER NOT NULL DEFAULT 0");
  addColumn("worktree_lineages", "integration_state", "integration_state TEXT NOT NULL DEFAULT 'active'");
  if (hasTable("worktree_lineages")) db.exec(`
    UPDATE worktree_lineages SET integration_ref='refs/heads/minions/integration/'||id
      WHERE integration_ref='';
    UPDATE worktree_lineages SET integration_worktree_path=repository_path||'/.canvas-worktrees/integration-'||id
      WHERE integration_worktree_path='';
    UPDATE worktree_lineages SET project_id=COALESCE((SELECT w.project_id
      FROM worktree_contributions c JOIN work_items w ON w.id=c.work_item_id
      WHERE c.lineage_id=worktree_lineages.id LIMIT 1),project_id) WHERE project_id='';
  `);
  addColumn("worktree_contributions", "revision", "revision INTEGER NOT NULL DEFAULT 0");
  addColumn("worktree_integration_queue", "revision", "revision INTEGER NOT NULL DEFAULT 0");
  addColumn("worktree_integration_queue", "fencing_token", "fencing_token INTEGER NOT NULL DEFAULT 0");
  addColumn("worktree_integration_queue", "expected_source_sha", "expected_source_sha TEXT");
  addColumn("worktree_integration_queue", "expected_target_sha", "expected_target_sha TEXT");
  addColumn("worktree_integration_queue", "conflict_details_json", "conflict_details_json TEXT");
  addColumn("worktree_integration_reviews", "reviewed_head_sha", "reviewed_head_sha TEXT");
  addColumn("worktree_integration_gates", "lineage_id", "lineage_id TEXT");
  addColumn("worktree_integration_gates", "scope", "scope TEXT NOT NULL DEFAULT 'contribution'");
  if (hasTable("worktree_integration_gates") && hasTable("worktree_contributions")) db.exec(`
    UPDATE worktree_integration_gates SET lineage_id=(SELECT lineage_id FROM worktree_contributions
      WHERE id=worktree_integration_gates.contribution_id) WHERE lineage_id IS NULL`);
  if (hasTable("worktree_contribution_runs")) {
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='worktree_contribution_runs'")
      .get() as { sql: string }).sql;
    if (!tableSql.includes("'iteration'")) db.exec(`
      ALTER TABLE worktree_contribution_runs RENAME TO worktree_contribution_runs_old;
      CREATE TABLE worktree_contribution_runs (
        contribution_id TEXT NOT NULL REFERENCES worktree_contributions(id), run_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('original','iteration','resolution')),
        attached_at INTEGER NOT NULL, PRIMARY KEY(contribution_id,run_key));
      INSERT INTO worktree_contribution_runs SELECT * FROM worktree_contribution_runs_old;
      DROP TABLE worktree_contribution_runs_old;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktree_lineages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repository_path TEXT NOT NULL,
      target_ref TEXT NOT NULL, base_sha TEXT NOT NULL,
      integration_ref TEXT NOT NULL, integration_worktree_path TEXT NOT NULL,
      integration_head_sha TEXT, revision INTEGER NOT NULL DEFAULT 0,
      integration_state TEXT NOT NULL DEFAULT 'active'
        CHECK(integration_state IN ('active','queued','integrating','conflicted','integrated','abandoned')),
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','integrated','abandoned')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worktree_lineage_target
      ON worktree_lineages(repository_path, target_ref, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_lineage_integration_ref
      ON worktree_lineages(repository_path, integration_ref);
    CREATE INDEX IF NOT EXISTS idx_worktree_lineage_project
      ON worktree_lineages(project_id, created_at);
    CREATE TABLE IF NOT EXISTS worktree_lineage_memberships (
      lineage_id TEXT NOT NULL REFERENCES worktree_lineages(id),
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','left')),
      revision INTEGER NOT NULL DEFAULT 0, actor TEXT NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER,
      PRIMARY KEY(lineage_id,work_item_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_member_active_item
      ON worktree_lineage_memberships(work_item_id) WHERE status='active';

    CREATE TABLE IF NOT EXISTS worktree_contributions (
      id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL REFERENCES worktree_lineages(id),
      work_item_id TEXT NOT NULL REFERENCES work_items(id), originating_run_key TEXT NOT NULL UNIQUE,
      branch_name TEXT NOT NULL UNIQUE, worktree_path TEXT NOT NULL UNIQUE,
      base_sha TEXT NOT NULL, head_sha TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'planned'
        CHECK(state IN ('planned','provisioning','active','ready','queued','integrating','integrated','conflicted','failed','discarded')),
      review_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(review_state IN ('pending','approved','rejected')),
      cleanup_state TEXT NOT NULL DEFAULT 'retained'
        CHECK(cleanup_state IN ('retained','eligible','cleaned')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worktree_contribution_lineage
      ON worktree_contributions(lineage_id, created_at);

    CREATE TABLE IF NOT EXISTS worktree_contribution_runs (
      contribution_id TEXT NOT NULL REFERENCES worktree_contributions(id),
      run_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('original','iteration','resolution')),
      attached_at INTEGER NOT NULL, PRIMARY KEY(contribution_id, run_key)
    );
    CREATE TABLE IF NOT EXISTS worktree_lineage_resolution_runs (
      lineage_id TEXT NOT NULL REFERENCES worktree_lineages(id),
      run_key TEXT NOT NULL UNIQUE, work_item_id TEXT NOT NULL REFERENCES work_items(id),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','resolved','failed')),
      revision INTEGER NOT NULL DEFAULT 0, head_sha TEXT, error TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER,
      PRIMARY KEY(lineage_id,run_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_lineage_active_resolution
      ON worktree_lineage_resolution_runs(lineage_id) WHERE state='active';

    CREATE TABLE IF NOT EXISTS worktree_integration_queue (
      id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL REFERENCES worktree_lineages(id),
      contribution_id TEXT REFERENCES worktree_contributions(id),
      kind TEXT NOT NULL CHECK(kind IN ('contribution','lineage')),
      repository_path TEXT NOT NULL, target_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      expected_source_sha TEXT NOT NULL, expected_target_sha TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'queued'
        CHECK(state IN ('queued','running','succeeded','conflicted','failed','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 1, fencing_token INTEGER NOT NULL DEFAULT 0, worker_id TEXT,
      result_sha TEXT, error TEXT, conflict_details_json TEXT, enqueued_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK((kind = 'contribution' AND contribution_id IS NOT NULL)
        OR (kind = 'lineage' AND contribution_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_worktree_queue_fifo
      ON worktree_integration_queue(repository_path, target_ref, state, enqueued_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_queue_running_scope
      ON worktree_integration_queue(repository_path, target_ref) WHERE state = 'running';

    CREATE TABLE IF NOT EXISTS worktree_integration_gates (
      id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL REFERENCES worktree_lineages(id),
      contribution_id TEXT REFERENCES worktree_contributions(id),
      scope TEXT NOT NULL CHECK(scope IN ('contribution','lineage')),
      name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','passed','failed','waived')),
      details TEXT, recorded_at INTEGER NOT NULL,
      CHECK((scope='contribution' AND contribution_id IS NOT NULL)
        OR (scope='lineage' AND contribution_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_gate_contribution
      ON worktree_integration_gates(contribution_id,name) WHERE scope='contribution';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_gate_lineage
      ON worktree_integration_gates(lineage_id,name) WHERE scope='lineage';
    CREATE TABLE IF NOT EXISTS worktree_integration_reviews (
      id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL REFERENCES worktree_lineages(id),
      contribution_id TEXT REFERENCES worktree_contributions(id),
      scope TEXT NOT NULL CHECK(scope IN ('contribution','lineage')),
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
      actor TEXT NOT NULL, notes TEXT, reviewed_head_sha TEXT, recorded_at INTEGER NOT NULL,
      CHECK((scope = 'contribution' AND contribution_id IS NOT NULL)
        OR (scope = 'lineage' AND contribution_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_worktree_reviews_scope
      ON worktree_integration_reviews(lineage_id, scope, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS worktree_integration_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, lineage_id TEXT NOT NULL,
      contribution_id TEXT, queue_id TEXT, event TEXT NOT NULL,
      actor TEXT, details TEXT, recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worktree_audit_lineage
      ON worktree_integration_audit(lineage_id, sequence);
    CREATE TABLE IF NOT EXISTS worktree_integration_commands (
      request_id TEXT PRIMARY KEY, command TEXT NOT NULL, input_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, recorded_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    UPDATE worktree_integration_queue SET expected_source_sha=CASE kind
      WHEN 'contribution' THEN COALESCE((SELECT COALESCE(head_sha,base_sha) FROM worktree_contributions
        WHERE id=worktree_integration_queue.contribution_id),'')
      ELSE COALESCE((SELECT COALESCE(integration_head_sha,base_sha) FROM worktree_lineages
        WHERE id=worktree_integration_queue.lineage_id),'') END
      WHERE expected_source_sha IS NULL;
    UPDATE worktree_integration_queue SET expected_target_sha=CASE kind
      WHEN 'contribution' THEN COALESCE((SELECT COALESCE(integration_head_sha,base_sha) FROM worktree_lineages
        WHERE id=worktree_integration_queue.lineage_id),'')
      ELSE COALESCE((SELECT base_sha FROM worktree_lineages
        WHERE id=worktree_integration_queue.lineage_id),'') END
      WHERE expected_target_sha IS NULL;
    INSERT OR IGNORE INTO worktree_lineage_memberships
      (lineage_id,work_item_id,status,revision,actor,joined_at,left_at)
    SELECT c.lineage_id,c.work_item_id,
      CASE WHEN l.status='open' AND c.lineage_id=(SELECT c2.lineage_id
        FROM worktree_contributions c2 JOIN worktree_lineages l2 ON l2.id=c2.lineage_id
        WHERE c2.work_item_id=c.work_item_id AND l2.status='open'
        ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) THEN 'active' ELSE 'left' END,
      0,'migration',MIN(c.created_at),
      CASE WHEN l.status='open' AND c.lineage_id=(SELECT c2.lineage_id
        FROM worktree_contributions c2 JOIN worktree_lineages l2 ON l2.id=c2.lineage_id
        WHERE c2.work_item_id=c.work_item_id AND l2.status='open'
        ORDER BY l2.updated_at DESC,l2.id DESC LIMIT 1) THEN NULL ELSE MAX(c.updated_at) END
    FROM worktree_contributions c JOIN worktree_lineages l ON l.id=c.lineage_id
    GROUP BY c.lineage_id,c.work_item_id;
  `);
}
