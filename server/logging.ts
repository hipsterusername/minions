import {
  createConsoleSink,
  createLogger,
  parseLogLevel,
  type ConsoleTarget,
  type Logger,
} from "../shared/logging.ts";

interface ServerLoggerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly target?: ConsoleTarget;
  readonly now?: () => Date;
}

export function createServerLogger(options: ServerLoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const target = options.target ?? globalThis.console;
  return createLogger({
    scope: "server",
    level: parseLogLevel(env["MINIONS_LOG_LEVEL"], "info"),
    sink: createConsoleSink(target),
    includePrivateFields: env["MINIONS_LOG_PRIVATE"] === "1",
    includeStacks: env["MINIONS_LOG_STACKS"] === "1",
    ...(options.now ? { now: options.now } : {}),
  });
}

export const serverLogger = createServerLogger();
