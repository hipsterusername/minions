import { describe, expect, it } from "vitest";
import {
  createConsoleSink,
  createLogger,
  parseLogLevel,
  type ConsoleTarget,
  type LogRecord,
} from "./logging.ts";

function captureLogger(
  options: Partial<{
    level: "debug" | "info" | "warn" | "error" | "silent";
    includePrivateFields: boolean;
    includeStacks: boolean;
  }> = {},
) {
  const records: LogRecord[] = [];
  const logger = createLogger({
    scope: "test",
    level: options.level ?? "debug",
    sink: { write: (record) => records.push(record) },
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    includePrivateFields: options.includePrivateFields ?? false,
    includeStacks: options.includeStacks ?? false,
  });
  return { logger, records };
}

describe("logging", () => {
  it("filters below the configured level and supports silent", () => {
    const warning = captureLogger({ level: "warn" });
    warning.logger.debug("debug");
    warning.logger.info("info");
    warning.logger.warn("warn");
    warning.logger.error("error");
    expect(warning.records.map((record) => record.level)).toEqual([
      "warn",
      "error",
    ]);

    const silent = captureLogger({ level: "silent" });
    silent.logger.error("error");
    expect(silent.records).toEqual([]);
  });

  it("creates deterministic structured records and child scopes", () => {
    const { logger, records } = captureLogger();
    logger.child("socket").info("connected", { clients: 1 });

    expect(records).toEqual([
      {
        timestamp: "2026-01-02T03:04:05.000Z",
        level: "info",
        scope: "test:socket",
        event: "connected",
        fields: { clients: 1 },
      },
    ]);
  });

  it("redacts credentials regardless of private-field settings", () => {
    const { logger, records } = captureLogger({ includePrivateFields: true });
    logger.info("request", {
      token: "abc123",
      nested: { authorization: "Bearer abc123", apiKey: "secret" },
    });

    expect(records[0]?.fields).toEqual({
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]", apiKey: "[REDACTED]" },
    });
  });

  it("redacts private fields by default and allows explicit server opt-in", () => {
    const hidden = captureLogger();
    hidden.logger.info("worktree", {
      worktreePath: "/workspace/repo/.worktrees/task",
      reason: "customer request",
    });
    expect(hidden.records[0]?.fields).toEqual({
      worktreePath: "[PRIVATE]",
      reason: "[PRIVATE]",
    });

    const visible = captureLogger({ includePrivateFields: true });
    visible.logger.info("worktree", {
      worktreePath: "/workspace/repo/.worktrees/task",
    });
    expect(visible.records[0]?.fields).toEqual({
      worktreePath: "/workspace/repo/.worktrees/task",
    });
  });

  it("normalizes errors without exposing stacks or private paths", () => {
    const { logger, records } = captureLogger();
    const error = new Error("failed in /workspace/private/repo/file.ts");
    error.stack = "Error: failed\n at /workspace/private/repo/file.ts:2:3";
    logger.error("failed", { error });

    expect(records[0]?.fields).toEqual({
      error: { name: "Error", message: "failed in [PRIVATE]" },
    });

    const withStack = captureLogger({ includeStacks: true });
    withStack.logger.error("failed", { error });
    expect(
      (withStack.records[0]?.fields?.["error"] as Record<string, unknown>)[
        "stack"
      ],
    ).toBe("Error: failed\n at [PRIVATE]:2:3");
  });

  it("handles cyclic and otherwise unsupported field values", () => {
    const { logger, records } = captureLogger();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    logger.info("values", { cyclic, count: 2n, callback: () => undefined });

    expect(records[0]?.fields).toEqual({
      cyclic: { self: "[Circular]" },
      count: "2",
      callback: "[function]",
    });
  });

  it("does not let sink failures alter application control flow", () => {
    const logger = createLogger({
      scope: "test",
      level: "info",
      sink: {
        write() {
          throw new Error("sink unavailable");
        },
      },
    });
    expect(() => logger.info("event")).not.toThrow();
  });

  it("routes records to the matching console target method", () => {
    const calls: string[] = [];
    const target: ConsoleTarget = {
      debug: () => calls.push("debug"),
      info: () => calls.push("info"),
      warn: () => calls.push("warn"),
      error: () => calls.push("error"),
    };
    const sink = createConsoleSink(target);
    for (const level of ["debug", "info", "warn", "error"] as const) {
      sink.write({
        timestamp: "2026-01-02T03:04:05.000Z",
        level,
        scope: "test",
        event: "event",
      });
    }
    expect(calls).toEqual(["debug", "info", "warn", "error"]);
  });

  it("parses supported levels and falls back for invalid input", () => {
    expect(parseLogLevel(" WARN ", "info")).toBe("warn");
    expect(parseLogLevel("verbose", "info")).toBe("info");
    expect(parseLogLevel(undefined, "error")).toBe("error");
  });
});
