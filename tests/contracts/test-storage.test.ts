import path from "node:path";
import { expect, it } from "vitest";
import { initDb } from "../../server/db.ts";
import { closePersistDb, openPersistDb } from "../../server/session-persist.ts";
import { getMinionsHome } from "../../server/workspace-registry.ts";
import { htmlArtifactsRoot, writeHtmlArtifact } from "../../server/html-artifact-store.ts";

// DOM suites can import server modules transitively, so they need the same
// storage boundary as server tests. The install regression runs this with
// inherited paths pointing at a simulated user's databases and artifacts.
it("isolates real persistence calls in every test environment", async () => {
  const home = getMinionsHome();
  expect(path.basename(home)).toMatch(/^minions-vitest-/);
  const db = openPersistDb();
  try {
    expect(db.name).toBe(path.join(home, "server.db"));
    db.prepare("INSERT INTO sessions (session_key, task_name) VALUES (?, ?)")
      .run("dom-storage-probe", "hi");
    expect(db.prepare("SELECT task_name FROM sessions WHERE session_key = ?")
      .get("dom-storage-probe")).toEqual({ task_name: "hi" });
  } finally {
    closePersistDb();
  }
  const canvas = initDb();
  try {
    expect(canvas.name).toBe(path.join(home, "canvas.db"));
  } finally {
    canvas.close();
  }
  expect(htmlArtifactsRoot()).toBe(path.join(home, "artifacts", "html"));
  await writeHtmlArtifact("dom-storage-probe", { id: "probe", html: "<p>test</p>" });
});
