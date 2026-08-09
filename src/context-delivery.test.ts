import { describe, it, expect } from "vitest";
import {
  seedContextDelivery,
  diffContextDelivery,
  buildContextUpdateBlock,
  type ContextUpdate,
} from "./context-delivery.ts";
import type { ContextItem } from "./types.ts";
import { TRANSCRIPT_BLOCK_SEPARATOR } from "./nodes/leader/transcript-builder.ts";

const T0 = 1_000;
const T1 = 2_000;

function plainItem(nodeId: string, content: string, label = "markdown"): ContextItem {
  return { nodeId, nodeType: "markdown", label, content };
}

/** Append-capable item, the shape produced by resolveLeaderContextItem. */
function transcriptItem(
  nodeId: string,
  blocks: string[],
  label = "Leader Session",
): ContextItem {
  return {
    nodeId,
    nodeType: "leader",
    label,
    content: blocks.join(TRANSCRIPT_BLOCK_SEPARATOR),
    blocks,
  };
}

// ── seedContextDelivery ───────────────────────────────────────────────────

describe("seedContextDelivery", () => {
  it("returns an empty ledger for no items", () => {
    expect(seedContextDelivery([], T0)).toEqual({});
  });

  it("records a hash and deliveredAt per source", () => {
    const ledger = seedContextDelivery([plainItem("n1", "hello")], T0);
    expect(ledger["n1"]).toMatchObject({ deliveredAt: T0 });
    expect(ledger["n1"]!.hash).toBeTypeOf("number");
    expect(ledger["n1"]!.version).toBeUndefined();
  });

  it("records a version watermark for append-capable sources", () => {
    const ledger = seedContextDelivery(
      [transcriptItem("leader-a", ["User:\nhi", "Assistant:\nhello"])],
      T0,
    );
    expect(ledger["leader-a"]).toMatchObject({ version: 2, deliveredAt: T0 });
    expect(ledger["leader-a"]!.prefixHash).toBeTypeOf("number");
  });
});

// ── diffContextDelivery ───────────────────────────────────────────────────

describe("diffContextDelivery", () => {
  it("treats everything as new against an empty ledger", () => {
    const items = [plainItem("n1", "a"), transcriptItem("l1", ["User:\nhi"])];
    const { newItems, updates, nextLedger } = diffContextDelivery(items, {}, T1);
    expect(newItems).toHaveLength(2);
    expect(updates).toHaveLength(0);
    expect(nextLedger).toHaveProperty("n1");
    expect(nextLedger).toHaveProperty("l1");
  });

  it("emits nothing when nothing changed, preserving deliveredAt", () => {
    const items = [plainItem("n1", "a"), transcriptItem("l1", ["User:\nhi"])];
    const ledger = seedContextDelivery(items, T0);
    const { newItems, updates, nextLedger } = diffContextDelivery(items, ledger, T1);
    expect(newItems).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(nextLedger["n1"]!.deliveredAt).toBe(T0);
    expect(nextLedger["l1"]!.deliveredAt).toBe(T0);
  });

  it("sends ONLY the suffix when a transcript source grows (append)", () => {
    const before = transcriptItem("l1", ["User:\nhi", "Assistant:\nhello"]);
    const ledger = seedContextDelivery([before], T0);
    const after = transcriptItem("l1", [
      "User:\nhi",
      "Assistant:\nhello",
      "User:\nnow do X",
      "Assistant:\ndone",
    ]);

    const { newItems, updates, nextLedger } = diffContextDelivery([after], ledger, T1);

    expect(newItems).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ nodeId: "l1", kind: "append" });
    // Suffix only — the previously delivered turns must NOT be re-sent.
    expect(updates[0]!.content).toBe(
      ["User:\nnow do X", "Assistant:\ndone"].join(TRANSCRIPT_BLOCK_SEPARATOR),
    );
    expect(updates[0]!.content).not.toContain("hello");
    // Watermark advances.
    expect(nextLedger["l1"]).toMatchObject({ version: 4, deliveredAt: T1 });
  });

  it("falls back to replace when the delivered prefix was rewritten", () => {
    const before = transcriptItem("l1", ["User:\nhi", "Assistant:\nhello"]);
    const ledger = seedContextDelivery([before], T0);
    // First block edited → prefix hash no longer matches.
    const after = transcriptItem("l1", ["User:\nEDITED", "Assistant:\nhello", "User:\nmore"]);

    const { updates } = diffContextDelivery([after], ledger, T1);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ nodeId: "l1", kind: "replace" });
    expect(updates[0]!.content).toBe(after.content);
  });

  it("falls back to replace when the transcript shrank below the watermark", () => {
    const before = transcriptItem("l1", ["a", "b", "c"]);
    const ledger = seedContextDelivery([before], T0);
    const after = transcriptItem("l1", ["a", "b"]);

    const { updates } = diffContextDelivery([after], ledger, T1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.kind).toBe("replace");
  });

  it("label-only change on an unchanged transcript re-sends nothing", () => {
    // The upstream leader gained a task name but produced no new turns:
    // spending tokens re-sending the whole transcript would be pure waste.
    const before = transcriptItem("l1", ["User:\nhi"], "Leader Session");
    const ledger = seedContextDelivery([before], T0);
    const after = transcriptItem("l1", ["User:\nhi"], "Auth Refactor");

    const { newItems, updates, nextLedger } = diffContextDelivery([after], ledger, T1);

    expect(newItems).toHaveLength(0);
    expect(updates).toHaveLength(0);
    // Ledger hash refreshed so the label change doesn't read as stale forever…
    const reDiff = diffContextDelivery([after], nextLedger, T1 + 1);
    expect(reDiff.updates).toHaveLength(0);
    // …but deliveredAt is preserved (nothing actually shipped).
    expect(nextLedger["l1"]!.deliveredAt).toBe(T0);
  });

  it("replaces changed non-transcript sources in full", () => {
    const ledger = seedContextDelivery([plainItem("n1", "old")], T0);
    const { updates } = diffContextDelivery([plainItem("n1", "new")], ledger, T1);
    expect(updates).toEqual([
      expect.objectContaining({ nodeId: "n1", kind: "replace", content: "new" }),
    ]);
  });

  it("drops removed sources from the next ledger without re-sending", () => {
    const ledger = seedContextDelivery([plainItem("n1", "a"), plainItem("n2", "b")], T0);
    const { newItems, updates, nextLedger } = diffContextDelivery(
      [plainItem("n1", "a")],
      ledger,
      T1,
    );
    expect(newItems).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(nextLedger).not.toHaveProperty("n2");
  });

  it("handles mixed new + append + replace in one turn", () => {
    const ledger = seedContextDelivery(
      [transcriptItem("l1", ["a"]), plainItem("n1", "old")],
      T0,
    );
    const { newItems, updates } = diffContextDelivery(
      [
        transcriptItem("l1", ["a", "b"]),
        plainItem("n1", "new"),
        plainItem("n2", "brand new"),
      ],
      ledger,
      T1,
    );
    expect(newItems.map((i) => i.nodeId)).toEqual(["n2"]);
    expect(updates.map((u) => [u.nodeId, u.kind])).toEqual([
      ["l1", "append"],
      ["n1", "replace"],
    ]);
  });
});

// ── buildContextUpdateBlock ───────────────────────────────────────────────

describe("buildContextUpdateBlock", () => {
  const update = (overrides: Partial<ContextUpdate>): ContextUpdate => ({
    nodeId: "l1",
    nodeType: "leader",
    label: "Upstream",
    kind: "append",
    content: "User:\nnew turn",
    ...overrides,
  });

  it("returns null for no updates", () => {
    expect(buildContextUpdateBlock([])).toBeNull();
  });

  it("wraps updates in <connected-context-update>, never <connected-context>", () => {
    const block = buildContextUpdateBlock([update({})])!;
    expect(block).toMatch(/^<connected-context-update>\n/);
    expect(block).toMatch(/<\/connected-context-update>$/);
    // Must NOT match the wrapper deriveTaskName strips — that regex targets
    // the literal `<connected-context>` open tag.
    expect(block).not.toMatch(/<connected-context>/);
  });

  it("marks groups with their update kind", () => {
    const block = buildContextUpdateBlock([
      update({ kind: "append" }),
      update({ nodeId: "n1", nodeType: "markdown", label: "Spec", kind: "replace", content: "v2" }),
    ])!;
    expect(block).toContain('<context-group title="Upstream" update="append">');
    expect(block).toContain('<context-group title="Spec" update="replace">');
  });

  it("omits the title attribute when label equals nodeType", () => {
    const block = buildContextUpdateBlock([
      update({ nodeType: "markdown", label: "Markdown", kind: "replace" }),
    ])!;
    expect(block).toContain('<context-group update="replace">');
    expect(block).not.toContain("title=");
  });
});
