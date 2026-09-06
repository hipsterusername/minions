import assert from "node:assert/strict";
import Database from "better-sqlite3";

const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
  db.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
  assert.deepEqual(db.prepare("SELECT value FROM smoke").get(), { value: "ok" });
  console.log("SQLite native binary: database creation, write, and read passed.");
} finally {
  db.close();
}
