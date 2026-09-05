import { afterEach, expect, it, vi } from "vitest";
const fault = vi.hoisted(() => ({ remaining: 0, attempts: 0 }));
vi.mock("./db.ts", async original => {
  const actual = await original<typeof import("./db.ts")>();
  return { ...actual, initDb: (...args: Parameters<typeof actual.initDb>) => {
    fault.attempts++;
    if (fault.remaining-- > 0) throw new Error("storage temporarily unavailable");
    return actual.initDb(...args);
  } };
});
import { closePersistDb, persistSession, persistenceDb, type PersistableSession } from "./session-persist.ts";

afterEach(() => { closePersistDb(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("reports a database-open failure and retries after a bounded cooldown", () => {
  vi.stubEnv("MINIONS_SERVER_DB", ":memory:");
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const session: PersistableSession = { id:"retry",cwd:"/tmp",status:"running",model:null,role:"leader",
    taskName:null,sessionId:null,worktreeIsolation:false,worktree:null,approval:null,totalCost:0,turns:0,harnessName:"echo" };
  fault.remaining = 1; fault.attempts = 0;
  expect(() => persistSession(session)).toThrow(/persistence is unavailable/);
  expect(() => persistSession(session)).toThrow(/persistence is unavailable/);
  expect(fault.attempts).toBe(1);
  now.mockReturnValue(2001);
  expect(() => persistSession(session)).not.toThrow();
  expect(fault.attempts).toBe(2);
  expect(persistenceDb()!.prepare("SELECT session_key FROM sessions").get()).toEqual({session_key:"retry"});
});
