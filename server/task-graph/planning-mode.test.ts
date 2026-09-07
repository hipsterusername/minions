import { describe, expect, it } from "vitest";
import { ensureWorkItemSchema } from "../work-item-schema.ts";
import { initDb } from "../db.ts";
import { leaderOrchestrationModeForRun } from "./planning-mode.ts";

describe("persisted Leader orchestration", () => {
  it.each([
    [null, "auto"],
    ['{"orchestrationMode":"direct"}', "auto"],
    ['{"orchestrationMode":"plan"}', "plan"],
    ['{"orchestrationMode":"auto"}', "auto"],
    ['{"orchestrationMode":"unknown"}', "auto"],
    ["invalid-json", "auto"],
  ])("resolves stored config %s to %s", (config, expected) => {
    const db = initDb(":memory:");
    try {
      ensureWorkItemSchema(db);
      db.prepare("INSERT INTO sessions(session_key, run_config_json) VALUES (?, ?)")
        .run("primary", config);
      expect(leaderOrchestrationModeForRun(db, "primary")).toBe(expected);
      expect(leaderOrchestrationModeForRun(db, "missing")).toBe("auto");
    } finally {
      db.close();
    }
  });
});
