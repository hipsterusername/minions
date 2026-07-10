import {
  createConsoleSink,
  createLogger,
  parseLogLevel,
  type ConsoleTarget,
  type Logger,
} from "../shared/logging.ts";

interface BrowserLoggerOptions {
  readonly dev: boolean;
  readonly configuredLevel?: string;
  readonly target?: ConsoleTarget;
  readonly now?: () => Date;
}

export function createBrowserLogger(options: BrowserLoggerOptions): Logger {
  return createLogger({
    scope: "browser",
    level: parseLogLevel(
      options.configuredLevel,
      options.dev ? "info" : "warn",
    ),
    sink: createConsoleSink(options.target ?? globalThis.console),
    ...(options.now ? { now: options.now } : {}),
  });
}

export const browserLogger = createBrowserLogger({
  dev: import.meta.env.DEV,
  configuredLevel: import.meta.env["VITE_MINIONS_LOG_LEVEL"],
});
