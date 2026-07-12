import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { kanbanCardMetadataSchema, type KanbanCardMetadata,
  type KanbanImportCard } from "../shared/work-item-kanban.ts";
import { workItemInputHash } from "./work-item-command-ledger.ts";
import { createWorkItem, getWorkItem, WorkItemConflictError,
  type WorkItemRow } from "./work-item-repo.ts";

function assertWorkflowRevision(row: WorkItemRow | null, expected: number): asserts row is WorkItemRow {
  if (!row) throw new WorkItemConflictError("work item not found", null);
  if (row.workflow_revision !== expected) throw new WorkItemConflictError("stale workflow revision", row);
}

export function updateWorkItemCard(db: Database.Database, input: {
  workItemId: string; expectedWorkflowRevision: number; title?: string;
  patch: Partial<KanbanCardMetadata>; at: number;
}): WorkItemRow {
  const row = getWorkItem(db, input.workItemId);
  assertWorkflowRevision(row, input.expectedWorkflowRevision);
  const card = kanbanCardMetadataSchema.parse({ ...JSON.parse(row.kanban_json), ...input.patch });
  const changed = db.prepare(`UPDATE work_items SET title = ?, kanban_json = ?,
    workflow_revision = workflow_revision + 1, updated_at = ?
    WHERE id = ? AND workflow_revision = ?`).run(input.title ?? row.title,
      JSON.stringify(card), input.at, row.id, row.workflow_revision);
  if (changed.changes !== 1) throw new WorkItemConflictError("concurrent workflow mutation", getWorkItem(db, row.id));
  return getWorkItem(db, row.id)!;
}

export function moveWorkItemCard(db: Database.Database, input: {
  workItemId: string; expectedWorkflowRevision: number;
  columnId: string; targetIndex?: number; rank?: string; at: number;
}): { moved: WorkItemRow; changed: WorkItemRow[] } {
  return db.transaction(() => {
    const row = getWorkItem(db, input.workItemId);
    assertWorkflowRevision(row, input.expectedWorkflowRevision);
    if (input.targetIndex === undefined) {
      db.prepare(`UPDATE work_items SET workflow_column_id = ?, workflow_rank = ?,
        workflow_revision = workflow_revision + 1, updated_at = ? WHERE id = ?`)
        .run(input.columnId, input.rank!, input.at, row.id);
      const moved = getWorkItem(db, row.id)!; return { moved, changed: [moved] };
    }
    const ids = (db.prepare(`SELECT id FROM work_items WHERE project_id = ?
      AND workflow_column_id = ? AND id <> ? ORDER BY workflow_rank, id`)
      .all(row.project_id, input.columnId, row.id) as Array<{ id: string }>).map(({ id }) => id);
    ids.splice(Math.max(0, Math.min(input.targetIndex, ids.length)), 0, row.id);
    const changed: WorkItemRow[] = [];
    ids.forEach((id, index) => {
      const current = getWorkItem(db, id)!; const rank = String(index).padStart(8, "0");
      if (current.workflow_column_id === input.columnId && current.workflow_rank === rank) return;
      db.prepare(`UPDATE work_items SET workflow_column_id = ?, workflow_rank = ?,
        workflow_revision = workflow_revision + 1, updated_at = ? WHERE id = ?`)
        .run(input.columnId, rank, input.at, id); changed.push(getWorkItem(db, id)!);
    });
    return { moved: getWorkItem(db, row.id)!, changed };
  }).immediate();
}

export function stableImportedWorkItemId(projectId: string, cardId: string): string {
  const hash = createHash("sha256").update(`${projectId}\0${cardId}`).digest("hex").slice(0, 32);
  return `work-kanban-${hash}`;
}

export function importKanbanBoard(db: Database.Database, input: {
  projectId: string; projectPath: string; migrationKey: string;
  cards: KanbanImportCard[]; at: number;
}): { rows: WorkItemRow[]; idempotent: boolean } {
  return db.transaction(() => {
    const stableCards = input.cards.map(({ existingWorkItemId: _mapping, ...card }) => card);
    const hash = workItemInputHash(stableCards);
    const prior = db.prepare(`SELECT input_hash FROM work_item_imports
      WHERE project_id = ? AND migration_key = ?`).get(input.projectId, input.migrationKey) as
      { input_hash: string } | undefined;
    if (prior) {
      if (prior.input_hash !== hash && prior.input_hash !== workItemInputHash(input.cards)) {
        throw new Error("idempotency migration was reused with different input");
      }
      const entries = db.prepare(`SELECT legacy_card_id, work_item_id FROM work_item_import_entries
        WHERE project_id = ? AND migration_key = ?`).all(input.projectId, input.migrationKey) as
        Array<{ legacy_card_id: string; work_item_id: string }>;
      const byLegacyId = new Map(entries.map((entry) => [entry.legacy_card_id, entry.work_item_id]));
      if (entries.length === 0) for (const card of input.cards) {
        const id = card.existingWorkItemId ?? stableImportedWorkItemId(input.projectId, card.id);
        if (getWorkItem(db, id)) {
          db.prepare(`INSERT OR IGNORE INTO work_item_import_entries
            (project_id, migration_key, legacy_card_id, work_item_id) VALUES (?, ?, ?, ?)`)
            .run(input.projectId, input.migrationKey, card.id, id); byLegacyId.set(card.id, id);
        }
      }
      const ids = [...new Set(input.cards.map((card) => byLegacyId.get(card.id)).filter(Boolean))] as string[];
      return { rows: ids.map((id) => getWorkItem(db, id)!).filter(Boolean), idempotent: true };
    }
    const seen = new Set<string>(); const rows: WorkItemRow[] = [];
    for (const card of input.cards) {
      if (seen.has(card.id)) continue; seen.add(card.id);
      const id = card.existingWorkItemId ?? stableImportedWorkItemId(input.projectId, card.id);
      const existing = getWorkItem(db, id);
      if (existing && existing.project_id !== input.projectId) {
        throw new WorkItemConflictError("import target belongs to another project", existing);
      }
      const metadata = JSON.stringify(kanbanCardMetadataSchema.parse({ ...card,
        legacyCardId: card.id, id: undefined, title: undefined, columnId: undefined,
        rank: undefined, createdAt: undefined, existingWorkItemId: undefined }));
      if (existing) {
        db.prepare(`UPDATE work_items SET title = ?, workflow_column_id = ?, workflow_rank = ?,
          kanban_json = ?, workflow_revision = workflow_revision + 1, updated_at = ? WHERE id = ?`)
          .run(card.title, card.columnId, card.rank, metadata, input.at, id);
        rows.push(getWorkItem(db, id)!);
      } else {
        rows.push(createWorkItem(db, { id, projectId: input.projectId,
          projectPath: input.projectPath, title: card.title,
          changeMode: card.worktreeIsolation ? "worktree" : "live",
          workflowColumnId: card.columnId, workflowRank: card.rank,
          kanbanJson: metadata,
          at: card.createdAt }));
      }
      db.prepare(`INSERT INTO work_item_import_entries
        (project_id, migration_key, legacy_card_id, work_item_id) VALUES (?, ?, ?, ?)`)
        .run(input.projectId, input.migrationKey, card.id, id);
    }
    db.prepare(`INSERT INTO work_item_imports (project_id, migration_key, input_hash,
      imported_count, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.projectId, input.migrationKey, hash, rows.length, input.at);
    return { rows, idempotent: false };
  }).immediate();
}
