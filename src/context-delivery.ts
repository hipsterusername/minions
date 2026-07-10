/**
 * Versioned delivery ledger for connected-context injection.
 *
 * Replaces the ephemeral hash-map delta (`seedContextHashes` /
 * `diffContextItems`) with a ledger persisted in `LeaderData.contextDelivery`
 * so it survives reloads, and upgrades transcript sources from
 * whole-item resend to suffix-only ("append") updates:
 *
 * - Sources that expose an append-only `blocks` list (leader transcripts in
 *   lean/full mode) record a watermark (`version` = blocks delivered) plus a
 *   `prefixHash` of the delivered content. On later turns, if the previously
 *   delivered prefix is intact, only the NEW blocks are sent — O(new turns)
 *   instead of O(whole transcript) per update.
 * - If the prefix no longer matches (upstream transcript was compacted or
 *   rewritten), delivery falls back to a full `replace` update.
 * - Sources without `blocks` (dashboards, markdown, images…) keep
 *   whole-item replace semantics, gated on a content hash as before.
 *
 * Updates for already-delivered sources are wrapped in a
 * `<connected-context-update>` block — deliberately distinct from the
 * `<connected-context>` wrapper, which is regex-matched by `deriveTaskName`
 * in `server/session-host-config.ts` and must not gain new call sites with
 * different semantics.
 */

import type { ContextItem } from "./types.ts";
import { hashString, itemContentHash } from "./connected-context.ts";
import { TRANSCRIPT_BLOCK_SEPARATOR } from "./nodes/leader/transcript-builder.ts";

// ── Types ─────────────────────────────────────────────────────────────────

/** What a downstream session has last received from one context source. */
export interface ContextDeliveryRecord {
  /** `itemContentHash` of the item as last delivered — change detection. */
  hash: number;
  /**
   * For append-capable sources: number of transcript blocks delivered.
   * Absent for replace-only sources.
   */
  version?: number;
  /**
   * `hashString` of the delivered blocks joined with
   * {@link TRANSCRIPT_BLOCK_SEPARATOR} — validates that the delivered prefix
   * is still intact before an append (suffix-only) update is allowed.
   */
  prefixHash?: number;
  /** Epoch ms when this source's content last shipped to the session. */
  deliveredAt: number;
}

/** nodeId → delivery record. Persisted in `LeaderData.contextDelivery`. */
export type ContextDeliveryLedger = Record<string, ContextDeliveryRecord>;

/** One pending update for a source that was already delivered once. */
export interface ContextUpdate {
  nodeId: string;
  nodeType: string;
  label: string;
  /**
   * "append": `content` contains ONLY the new suffix since last delivery.
   * "replace": `content` fully supersedes the previously delivered version.
   */
  kind: "append" | "replace";
  content: string;
}

export interface ContextDeliveryDiff {
  /** Sources never delivered before — inject via `buildContextBlock`. */
  newItems: ContextItem[];
  /** Sources delivered before whose content changed — inject via
   *  `buildContextUpdateBlock`. */
  updates: ContextUpdate[];
  /** Ledger to persist for the next turn. Sources no longer connected simply
   *  drop out. */
  nextLedger: ContextDeliveryLedger;
}

// ── Ledger construction ───────────────────────────────────────────────────

function recordFor(item: ContextItem, deliveredAt: number): ContextDeliveryRecord {
  const record: ContextDeliveryRecord = {
    hash: itemContentHash(item),
    deliveredAt,
  };
  if (item.blocks) {
    record.version = item.blocks.length;
    record.prefixHash = hashString(item.blocks.join(TRANSCRIPT_BLOCK_SEPARATOR));
  }
  return record;
}

/**
 * Seed a fresh ledger from a full set of context items. Call at
 * session-creation time, when the whole `<connected-context>` block ships.
 */
export function seedContextDelivery(
  items: ContextItem[],
  deliveredAt: number,
): ContextDeliveryLedger {
  const ledger: ContextDeliveryLedger = {};
  for (const item of items) {
    ledger[item.nodeId] = recordFor(item, deliveredAt);
  }
  return ledger;
}

// ── Diffing ───────────────────────────────────────────────────────────────

/**
 * True when `record`'s delivered prefix is still the head of `blocks`, i.e.
 * the source only appended since last delivery.
 */
function appendWatermarkValid(
  blocks: string[],
  record: ContextDeliveryRecord,
): boolean {
  if (record.version == null || record.prefixHash == null) return false;
  if (record.version > blocks.length) return false;
  const prefix = blocks.slice(0, record.version).join(TRANSCRIPT_BLOCK_SEPARATOR);
  return hashString(prefix) === record.prefixHash;
}

/**
 * Diff the current context items against what the session has already
 * received.
 *
 * - Never-delivered items land in `newItems` (full content, standard block).
 * - Changed append-capable items with an intact watermark produce an
 *   `append` update carrying only the new blocks.
 * - Changed items otherwise produce a `replace` update (full content).
 * - Append sources whose content is unchanged but whose label/metadata moved
 *   (e.g. the upstream leader got a task name) refresh the ledger silently —
 *   no tokens are spent re-sending an unchanged transcript.
 * - Unchanged items carry their record forward, preserving `deliveredAt`.
 */
export function diffContextDelivery(
  items: ContextItem[],
  ledger: ContextDeliveryLedger,
  now: number,
): ContextDeliveryDiff {
  const newItems: ContextItem[] = [];
  const updates: ContextUpdate[] = [];
  const nextLedger: ContextDeliveryLedger = {};

  for (const item of items) {
    const record = ledger[item.nodeId];

    if (!record) {
      newItems.push(item);
      nextLedger[item.nodeId] = recordFor(item, now);
      continue;
    }

    if (record.hash === itemContentHash(item)) {
      // Unchanged — keep the original deliveredAt.
      nextLedger[item.nodeId] = record;
      continue;
    }

    if (item.blocks && appendWatermarkValid(item.blocks, record)) {
      const suffix = item.blocks
        .slice(record.version)
        .join(TRANSCRIPT_BLOCK_SEPARATOR);
      if (!suffix) {
        // Content prefix intact and nothing appended: only the label or
        // other metadata changed. Refresh the record without re-sending.
        nextLedger[item.nodeId] = { ...recordFor(item, now), deliveredAt: record.deliveredAt };
        continue;
      }
      updates.push({
        nodeId: item.nodeId,
        nodeType: item.nodeType,
        label: item.label,
        kind: "append",
        content: suffix,
      });
      nextLedger[item.nodeId] = recordFor(item, now);
      continue;
    }

    updates.push({
      nodeId: item.nodeId,
      nodeType: item.nodeType,
      label: item.label,
      kind: "replace",
      content: item.content,
    });
    nextLedger[item.nodeId] = recordFor(item, now);
  }

  return { newItems, updates, nextLedger };
}

// ── Update block builder ──────────────────────────────────────────────────

/**
 * Build a `<connected-context-update>` block from pending updates.
 *
 * Distinct wrapper from `buildContextBlock`'s `<connected-context>` on
 * purpose: the model is told these are amendments to context it already has,
 * and `deriveTaskName`'s wrapper-stripping regex (which matches the literal
 * `<connected-context>` tag) never sees this block as a task-name source.
 *
 * Returns `null` when there are no updates.
 */
export function buildContextUpdateBlock(updates: ContextUpdate[]): string | null {
  if (updates.length === 0) return null;

  const groups = updates
    .map((update) => {
      const isDefault =
        update.label.toLowerCase() === update.nodeType.toLowerCase();
      const titleAttr = isDefault ? "" : ` title="${update.label}"`;
      return `<context-group${titleAttr} update="${update.kind}">\n${update.content}\n</context-group>`;
    })
    .join("\n");

  return `<connected-context-update>\nConnected context previously provided in this conversation has changed. Groups marked update="append" contain only NEW content that continues what you already received for that group; groups marked update="replace" fully supersede the earlier version of that group.\n\n${groups}\n</connected-context-update>`;
}
