/**
 * Contract tests for the per-project routine REST routes.
 *
 * Spins up a real Express server (port 0 = OS-assigned) backed by a
 * temporary directory under the user's home folder (required by path-guard),
 * then drives the four endpoints with native `fetch` calls.  No mocks touch
 * the HTTP or storage layers — only the path-guard registry is seeded.
 *
 * What we verify
 * ──────────────
 *   GET   /:encodedPath/routines          returns the routines array
 *   PUT   /:encodedPath/routines/:id      rejects malformed payloads (422
 *                                          with structured errors); accepts
 *                                          valid ones (200)
 *   PUT → GET                            round-trips identically through
 *                                          routine-store's parseRoutine
 *   DELETE /:encodedPath/routines/:id    removes the file on first call
 *                                         (200) and returns 404 thereafter
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { FAKE_HOME } = vi.hoisted(() => ({
  FAKE_HOME: require("path").resolve(require("os").tmpdir(), `minions-fakehome-routine-routes-${process.pid}`),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import { mountRoutinesRoutes } from "../../server/routes/projects/routines.ts";
import {
  registerProjectPath,
  unregisterProjectPath,
} from "../../server/path-guard.ts";
import { createExpressFetch } from "../harness/in-process-http.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function encodePath(p: string): string {
  return Buffer.from(p).toString("base64url");
}

function buildApp(): express.Express {
  const router = Router();
  mountRoutinesRoutes(router);
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_ROUTINE = {
  id: "my-routine",
  name: "My Routine",
  description: "Contract test routine",
  version: 1,
  inputs: [{ name: "topic", label: "Topic", required: true }],
  phases: [
    {
      id: "phase-1",
      label: "Phase 1",
      steps: [
        {
          id: "step-1",
          label: "Step 1",
          agent: "leader",
          routinePrompt: "Research {{inputs.topic}}.",
          skillIds: [],
          skillValues: {},
          mcpServerIds: [],
        },
      ],
    },
  ],
  failurePolicy: "fail-fast",
} as const;

// ── Shared server state ───────────────────────────────────────────────────────

let fetch: typeof globalThis.fetch;
let baseUrl: string;
let projectPath: string;
let encodedPath: string;

beforeAll(async () => {
  // path-guard requires the project path to be under the home directory.
  // Use a mocked ~/.tmp/ so we stay out of the repo tree and real home.
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  const tmpBase = path.join(os.homedir(), ".tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  projectPath = fs.mkdtempSync(
    path.join(tmpBase, "routine-routes-contract-"),
  );
  registerProjectPath(projectPath);
  encodedPath = encodePath(projectPath);

  baseUrl = "http://in-process.local";
  fetch = createExpressFetch(buildApp(), baseUrl);
});

afterAll(async () => {
  unregisterProjectPath(projectPath);
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

/** Convenience: delete a routine file directly so each sub-suite starts clean. */
function purgeRoutine(routineId: string): void {
  const file = path.join(
    projectPath,
    ".claude-canvas",
    "routines",
    `${routineId}.json`,
  );
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── GET list (empty) ──────────────────────────────────────────────────────────

describe("GET /:encodedPath/routines (empty store)", () => {
  it("returns 200 with empty arrays when no routines exist", async () => {
    purgeRoutine(VALID_ROUTINE.id);

    const res = await fetch(`${baseUrl}/${encodedPath}/routines`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routines: unknown[]; invalid: unknown[] };
    expect(body.routines).toEqual([]);
    expect(body.invalid).toEqual([]);
  });
});

// ── PUT validation ────────────────────────────────────────────────────────────

describe("PUT /:encodedPath/routines/:routineId — validation", () => {
  it("rejects missing-phases payload with 422 and error=schema", async () => {
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/my-routine`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "my-routine",
          name: "Bad Routine",
          version: 1,
        }),
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; errors: unknown[] };
    expect(body.error).toBe("schema");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("rejects an empty-phases array with 422 and error=schema", async () => {
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/my-routine`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "my-routine",
          name: "Bad Routine",
          version: 1,
          inputs: [],
          phases: [],
          failurePolicy: "fail-fast",
        }),
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("schema");
  });

  it("rejects duplicate step ids with 422 and error=duplicate-ids", async () => {
    const dupRoutine = {
      ...VALID_ROUTINE,
      phases: [
        {
          id: "phase-1",
          label: "Phase 1",
          steps: [
            {
              id: "step-dup",
              label: "First",
              agent: "leader",
              routinePrompt: "Do A.",
              skillIds: [],
              skillValues: {},
              mcpServerIds: [],
            },
            {
              id: "step-dup", // duplicate
              label: "Second",
              agent: "leader",
              routinePrompt: "Do B.",
              skillIds: [],
              skillValues: {},
              mcpServerIds: [],
            },
          ],
        },
      ],
    };

    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/my-routine`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dupRoutine),
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      errors: { path: string; message: string }[];
    };
    expect(body.error).toBe("duplicate-ids");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.some((e) => e.path.includes("step-dup"))).toBe(true);
  });
});

// ── PUT → GET round-trip ──────────────────────────────────────────────────────

describe("PUT → GET round-trip", () => {
  // Save the routine once before all tests in this suite run.
  beforeAll(async () => {
    purgeRoutine(VALID_ROUTINE.id);
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/${VALID_ROUTINE.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ROUTINE),
      },
    );
    expect(res.status).toBe(200);
  });

  afterAll(() => purgeRoutine(VALID_ROUTINE.id));

  it("PUT returns updatedAt stamped by the store", async () => {
    // Re-save to capture the response directly in this test.
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/${VALID_ROUTINE.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_ROUTINE),
      },
    );
    expect(res.status).toBe(200);
    const saved = (await res.json()) as typeof VALID_ROUTINE & {
      updatedAt: string;
    };
    expect(saved.id).toBe(VALID_ROUTINE.id);
    expect(saved.name).toBe(VALID_ROUTINE.name);
    expect(typeof saved.updatedAt).toBe("string");
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("GET list includes the saved routine", async () => {
    const res = await fetch(`${baseUrl}/${encodedPath}/routines`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      routines: (typeof VALID_ROUTINE)[];
      invalid: unknown[];
    };
    const found = body.routines.find((r) => r.id === VALID_ROUTINE.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe(VALID_ROUTINE.name);
    expect(found!.phases).toHaveLength(1);
    expect(found!.phases[0]!.steps).toHaveLength(1);
    expect(found!.inputs[0]!.name).toBe("topic");
  });

  it("GET one returns identical shape to what was PUT", async () => {
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/${VALID_ROUTINE.id}`,
    );
    expect(res.status).toBe(200);
    const one = (await res.json()) as typeof VALID_ROUTINE;
    expect(one.id).toBe(VALID_ROUTINE.id);
    expect(one.phases[0]!.id).toBe("phase-1");
    expect(one.phases[0]!.steps[0]!.id).toBe("step-1");
    expect(one.phases[0]!.steps[0]!.routinePrompt).toBe(
      "Research {{inputs.topic}}.",
    );
  });
});

// ── DELETE (idempotent) ───────────────────────────────────────────────────────

describe("DELETE /:encodedPath/routines/:routineId", () => {
  const DELETABLE_ID = "delete-me";

  beforeAll(async () => {
    // Seed a routine to delete.
    const seeded = {
      ...VALID_ROUTINE,
      id: DELETABLE_ID,
      name: "Delete Me",
    };
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/${DELETABLE_ID}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seeded),
      },
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 { ok: true } on first delete", async () => {
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/${DELETABLE_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 404 on a second delete — file is already gone", async () => {
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/${DELETABLE_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });

  it("GET list no longer includes the deleted routine", async () => {
    const res = await fetch(`${baseUrl}/${encodedPath}/routines`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routines: { id: string }[] };
    expect(body.routines.find((r) => r.id === DELETABLE_ID)).toBeUndefined();
  });
});

// ── GET one — 404 paths ───────────────────────────────────────────────────────

describe("GET /:encodedPath/routines/:routineId", () => {
  it("returns 404 when the routine id does not exist", async () => {
    purgeRoutine("nonexistent-id");
    const res = await fetch(
      `${baseUrl}/${encodedPath}/routines/nonexistent-id`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing");
  });
});

// ── Security ──────────────────────────────────────────────────────────────────

describe("Security: unregistered project path", () => {
  it("returns 403 when encodedPath is not in the registry", async () => {
    // Use a temp dir that was never registered.
    const unregistered = encodePath(
      path.join(os.homedir(), ".tmp", "not-registered-xyzzy"),
    );
    const res = await fetch(`${baseUrl}/${unregistered}/routines`);
    expect(res.status).toBe(403);
  });
});
