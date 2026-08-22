import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  graphSnapshotSchema, sourceSnapshotSchema, type GraphRevisionInput,
  type GraphSnapshot, type SourceSnapshot,
} from "../../shared/task-graph-contracts.ts";
import { TaskGraphConflictError, TaskGraphValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { migrateTaskGraph } from "./schema.ts";
import { validateRevision } from "./validation.ts";

type Row = Record<string, unknown>;
const parse = (value: unknown): unknown => JSON.parse(String(value));

export class TaskGraphRepository {
  constructor(readonly db: Database.Database) { migrateTaskGraph(db); }

  createRevision(raw: unknown, at: number): GraphRevisionInput {
    const spec = validateRevision(raw); const hash = contentHash(spec);
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT content_hash,spec_json FROM task_graph_revisions WHERE id=?").get(spec.revisionId) as Row | undefined;
      if (prior) {
        if (prior.content_hash !== hash) throw new TaskGraphConflictError("revision is immutable");
        return validateRevision(parse(prior.spec_json));
      }
      const definition = this.db.prepare("SELECT * FROM task_graph_definitions WHERE id=?").get(spec.definitionId) as Row | undefined;
      if (definition && (definition.work_item_id !== spec.workItemId || definition.workspace_id !== spec.workspaceId)) {
        throw new TaskGraphConflictError("definition ownership mismatch");
      }
      this.db.prepare("INSERT OR IGNORE INTO task_graph_definitions VALUES(?,?,?,?)")
        .run(spec.definitionId, spec.workItemId, spec.workspaceId, at);
      this.db.prepare("INSERT INTO task_graph_revisions VALUES(?,?,?,?,?)")
        .run(spec.revisionId, spec.definitionId, JSON.stringify(spec), hash, at);
      const insertNode = this.db.prepare("INSERT INTO task_graph_nodes VALUES(?,?,?,?)");
      spec.nodes.forEach((node, ordinal) => insertNode.run(spec.revisionId, node.id, ordinal, JSON.stringify(node)));
      const insertEdge = this.db.prepare("INSERT INTO task_graph_edges VALUES(?,?,?,?,?)");
      spec.edges.forEach(edge => insertEdge.run(spec.revisionId, edge.id, edge.sourceNodeId, edge.targetNodeId, JSON.stringify(edge)));
      return spec;
    }).immediate();
  }

  startRun(input: { id: string; workItemId: string; primaryRunKey: string; revisionId: string;
    sourceSnapshot: SourceSnapshot; expectedLifecycleRevision: number; at: number }): GraphSnapshot {
    return this.db.transaction(() => {
      const duplicate = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?")
        .get(input.id) as Row | undefined;
      if (duplicate) {
        const source=this.db.prepare("SELECT content_hash FROM task_source_snapshots WHERE id=?")
          .get(duplicate.source_snapshot_id) as Row|undefined;
        if (duplicate.work_item_id!==input.workItemId
          || duplicate.primary_run_key!==input.primaryRunKey
          || duplicate.revision_id!==input.revisionId
          || duplicate.source_snapshot_id!==input.sourceSnapshot.id
          || source?.content_hash!==contentHash(sourceSnapshotSchema.parse(input.sourceSnapshot))) {
          throw new TaskGraphConflictError("graph run replay does not match immutable run",
            this.snapshot(String(duplicate.id)));
        }
        return this.snapshot(String(duplicate.id));
      }
      const active=this.db.prepare(`SELECT id FROM task_graph_runs WHERE work_item_id=?
        AND primary_run_key=? AND status NOT IN ('completed','failed','cancelled')
        ORDER BY created_at DESC,id DESC LIMIT 1`).get(
        input.workItemId,input.primaryRunKey) as Row|undefined;
      if (active) {
        throw new TaskGraphConflictError(
          "another graph run is active; cancel it before starting a successor",
          this.snapshot(String(active.id)),
        );
      }
      const workItem = this.db.prepare("SELECT lifecycle_revision,current_run_key FROM work_items WHERE id=?")
        .get(input.workItemId) as Row | undefined;
      if (!workItem || workItem.lifecycle_revision !== input.expectedLifecycleRevision || workItem.current_run_key !== input.primaryRunKey) {
        throw new TaskGraphConflictError("stale canonical WorkItem authority", workItem ?? null);
      }
      const revision = this.getRevision(input.revisionId);
      if (revision.workItemId !== input.workItemId) throw new TaskGraphValidationError("revision belongs to another WorkItem");
      const source = sourceSnapshotSchema.parse(input.sourceSnapshot);
      if (source.workItemId !== input.workItemId || source.primaryRunKey !== input.primaryRunKey
        || source.taskGraphRevisionId !== input.revisionId || source.workspaceId !== revision.workspaceId
        || source.createdAt > input.at) {
        throw new TaskGraphValidationError("source snapshot authority mismatch");
      }
      const existingSource=this.db.prepare("SELECT * FROM task_source_snapshots WHERE id=?").get(source.id) as Row|undefined;
      if (existingSource && (existingSource.run_key!==input.primaryRunKey
        || existingSource.revision_id!==input.revisionId || existingSource.content_hash!==contentHash(source))) {
        throw new TaskGraphConflictError("source snapshot is immutable");
      }
      if (!existingSource) this.db.prepare("INSERT INTO task_source_snapshots VALUES(?,?,?,?,?,?)")
        .run(source.id, input.primaryRunKey, input.revisionId, JSON.stringify(source), contentHash(source), source.createdAt);
      this.db.prepare("INSERT INTO task_graph_runs VALUES(?,?,?,?,?,'active',0,0,?,?,?)")
        .run(input.id, input.workItemId, input.primaryRunKey, input.revisionId, source.id,
          revision.maxActiveAttempts, input.at, input.at);
      const incoming = new Map<string, string[]>();
      for (const edge of revision.edges) if (!edge.optional) incoming.set(edge.targetNodeId,
        [...(incoming.get(edge.targetNodeId) ?? []), edge.sourceNodeId]);
      const join = this.db.prepare("INSERT INTO task_frozen_joins VALUES(?,?,?,?,?,?)");
      for (const [nodeId, cohort] of incoming) {
        const incomingEdges=revision.edges.filter(edge => edge.targetNodeId === nodeId && !edge.optional);
        const policies = incomingEdges.map(edge => edge.satisfactionPolicy);
        const policy = policies.includes("reduce") ? "reduce" : policies.includes("quorum") ? "quorum" : policies.includes("any_success") ? "any_success" : policies.includes("all_terminal") ? "all_terminal" : "all_success";
        const frozenCohort=[...new Set(cohort)].sort();
        const quorum=policy === "quorum"
          ? incomingEdges.find(edge=>edge.satisfactionPolicy === "quorum")?.quorum ?? Math.ceil(frozenCohort.length/2)
          : null;
        join.run(input.id, nodeId, policy, quorum, JSON.stringify(frozenCohort), input.at);
      }
      this.appendEvent(input.id, 0, "run_started", input.id, `start:${input.id}`, {}, input.at);
      return this.snapshot(input.id);
    }).immediate();
  }

  getRevision(id: string): GraphRevisionInput {
    const row = this.db.prepare("SELECT spec_json FROM task_graph_revisions WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new TaskGraphValidationError("graph revision not found");
    return validateRevision(parse(row.spec_json));
  }

  casRun(runId: string, expected: number, updates: { status?: string; paused?: boolean }, at: number): number {
    this.assertCanonicalRun(runId);
    const result = this.db.prepare(`UPDATE task_graph_runs SET status=COALESCE(?,status), paused=COALESCE(?,paused),
      revision=revision+1, updated_at=? WHERE id=? AND revision=?`)
      .run(updates.status ?? null, updates.paused === undefined ? null : Number(updates.paused), at, runId, expected);
    if (result.changes !== 1) throw new TaskGraphConflictError("stale graph-run revision", this.snapshot(runId));
    return expected + 1;
  }

  assertCanonicalRun(runId: string): void {
    const run = this.db.prepare("SELECT work_item_id,primary_run_key FROM task_graph_runs WHERE id=?").get(runId) as Row | undefined;
    const workItem = run ? this.db.prepare("SELECT current_run_key FROM work_items WHERE id=?").get(run.work_item_id) as Row | undefined : undefined;
    if (!run || !workItem || workItem.current_run_key !== run.primary_run_key) {
      throw new TaskGraphConflictError("graph run lost canonical WorkItem authority",workItem ?? null);
    }
  }

  appendEvent(runId: string, revision: number, type: string, objectId: string, key: string, payload: unknown, at: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO task_scheduler_events
      (run_id,run_revision,type,object_id,idempotency_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(runId, revision, type, objectId, key, JSON.stringify(payload), at);
  }

  snapshot(runId: string, eventLimit = 500): GraphSnapshot {
    const run = this.db.prepare("SELECT * FROM task_graph_runs WHERE id=?").get(runId) as Row | undefined;
    if (!run) throw new TaskGraphValidationError("graph run not found");
    const revision = this.getRevision(String(run.revision_id));
    const sourceRow = this.db.prepare("SELECT snapshot_json FROM task_source_snapshots WHERE id=?").get(run.source_snapshot_id) as Row;
    const rows = (table: string, order: string) => this.db.prepare(`SELECT * FROM ${table} WHERE run_id=? ORDER BY ${order}`).all(runId) as Row[];
    const events = this.db.prepare("SELECT * FROM task_scheduler_events WHERE run_id=? ORDER BY sequence DESC LIMIT ?").all(runId,eventLimit) as Row[];
    return graphSnapshotSchema.parse({
      run: { id: run.id, workItemId: run.work_item_id, primaryRunKey: run.primary_run_key,
        revisionId: run.revision_id, sourceSnapshotId: run.source_snapshot_id, status: run.status,
        paused: Boolean(run.paused), revision: run.revision, maxActiveAttempts: run.max_active_attempts,
        createdAt: run.created_at, updatedAt: run.updated_at },
      revision, sourceSnapshot: parse(sourceRow.snapshot_json),
      attempts: this.attemptRows(runId),
      artifacts: rows("task_artifacts", "created_at,id").map(this.mapJson("metadata_json")),
      verifications: rows("task_verifications", "created_at,id").map(this.mapJson("record_json")),
      verificationRequests: rows("task_verification_requests", "created_at,id"),
      humanInputs: rows("task_human_inputs", "created_at,id")
        .map(this.mapJson("edge_ids_json")).map(this.mapJson("record_json")),
      edgeEvaluations: rows("task_edge_evaluations", "edge_id"), reservations: rows("task_resource_reservations", "id"),
      joins: rows("task_frozen_joins", "node_id").map(this.mapJson("cohort_json")),
      outbox: rows("task_scheduler_outbox", "created_at,id").map(this.mapJson("payload_json")),
      schedulerLease: (this.db.prepare("SELECT * FROM task_scheduler_leases WHERE run_id=?").get(runId) as Row | undefined) ?? null,
      expansions: rows("task_expansion_instances", "ordinal").map(this.mapJson("payload_json")),
      reductions: rows("task_reductions", "created_at,id"),
      reconciliations: rows("task_reconciliations", "created_at,id").map(this.mapJson("record_json")),
      steeringEvents: rows("task_graph_steering_events", "created_at,id").map(this.mapJson("record_json")),
      invalidations: rows("task_node_invalidations", "created_at,node_id"),
      adjudications: rows("task_node_adjudications", "created_at,id"),
      usage: this.usageRows(runId),
      contextSources:(this.db.prepare(`SELECT node_id,source_id,content_hash,classification,content
        FROM task_graph_context_sources WHERE source_snapshot_id=? ORDER BY node_id,source_id`)
        .all(run.source_snapshot_id) as Row[]).map(row=>({
          nodeId:String(row.node_id),sourceId:String(row.source_id),contentHash:String(row.content_hash),
          classification:String(row.classification),content:String(row.content),
        })),
      events: events.reverse().map(e => ({ sequence:e.sequence,runId:e.run_id,runRevision:e.run_revision,type:e.type,
        objectId:e.object_id,payload:parse(e.payload_json),createdAt:e.created_at })),
    });
  }

  private mapJson(column: string): (row: Row) => Row {
    return row => ({ ...row, [column]: row[column] == null ? null : parse(row[column]) });
  }
  private attemptRows(runId:string):Row[] {
    const sessionColumns=new Set((this.db.prepare("PRAGMA table_info('sessions')").all() as Row[])
      .map(row=>String(row.name)));
    const select=sessionColumns.has("final_report")
      ? `SELECT a.*,s.final_report FROM task_node_attempts a
          LEFT JOIN sessions s ON s.session_key=a.session_run_key
          WHERE a.run_id=? ORDER BY a.created_at,a.id`
      : `SELECT * FROM task_node_attempts WHERE run_id=? ORDER BY created_at,id`;
    return (this.db.prepare(select).all(runId) as Row[]).map(this.mapJson("terminal_witness_json"));
  }
  private usageRows(runId:string):Row[] {
    const tables=new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('sessions','session_usage')`).all() as Row[]).map(row=>String(row.name)));
    if (!tables.has("sessions") || !tables.has("session_usage")) return [];
    return this.db.prepare(`WITH token_usage AS (
        SELECT session_key,COALESCE(SUM(input_tokens+output_tokens),0) tokens
        FROM session_usage WHERE COALESCE(source,'assistant') IN ('assistant','turn_completed')
        GROUP BY session_key
      ), graph_sessions AS (
        SELECT a.id attempt_id,a.node_id,a.session_run_key session_key,'producer' usage_kind
        FROM task_node_attempts a WHERE a.run_id=? AND a.session_run_key IS NOT NULL
        UNION ALL
        SELECT r.verifier_attempt_id,r.node_id,r.verifier_run_key,'verifier'
        FROM task_verification_requests r WHERE r.run_id=? AND r.verifier_run_key IS NOT NULL
      )
      SELECT g.attempt_id,g.node_id,g.session_key,g.usage_kind,
        COALESCE(s.total_cost,0) cost_usd,COALESCE(u.tokens,0) tokens
      FROM graph_sessions g LEFT JOIN sessions s ON s.session_key=g.session_key
      LEFT JOIN token_usage u ON u.session_key=g.session_key
      ORDER BY g.node_id,g.attempt_id`).all(runId,runId) as Row[];
  }
  newId(prefix: string): string { return `${prefix}_${randomUUID()}`; }
}
