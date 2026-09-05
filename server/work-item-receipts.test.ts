import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initDb } from "./db.ts";
import { ensureWorkItemSchema } from "./work-item-schema.ts";
import { getWorkItemReceipt, saveWorkItemReceipt } from "./work-item-receipts.ts";

describe("completed work-item receipts", () => {
  it("retains the original completed response across database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "work-item-receipts-"));
    const path = join(directory, "test.db");
    const response = { type: "work_item_response", requestId: "request-1", success: false,
      error: "Rejected", code: "conflict", latest: null };
    try {
      const db = initDb(path);
      ensureWorkItemSchema(db);
      expect(getWorkItemReceipt(db, "request-1")).toBeNull();
      saveWorkItemReceipt(db, "request-1", response, 1);
      saveWorkItemReceipt(db, "request-1", { ...response, success: true }, 2);
      db.close();
      const reopened = initDb(path);
      ensureWorkItemSchema(reopened);
      expect(getWorkItemReceipt(reopened, "request-1")).toEqual(response);
      reopened.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("bounds retained responses by count and age", () => {
    const db = initDb(":memory:");
    ensureWorkItemSchema(db);
    try {
      for (let index = 0; index <= 1000; index++) saveWorkItemReceipt(db, String(index), { index }, index);
      expect(getWorkItemReceipt(db, "0")).toBeNull();
      expect(getWorkItemReceipt(db, "1")).toEqual({ index: 1 });
      saveWorkItemReceipt(db, "new", { success: true }, 8 * 24 * 60 * 60 * 1000);
      expect(getWorkItemReceipt(db, "1000")).toBeNull();
      expect(getWorkItemReceipt(db, "new")).toEqual({ success: true });
    } finally { db.close(); }
  });
});
