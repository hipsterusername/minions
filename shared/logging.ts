export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type EmittedLogLevel = Exclude<LogLevel, "silent">;
export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly timestamp: string;
  readonly level: EmittedLogLevel;
  readonly scope: string;
  readonly event: string;
  readonly fields?: LogFields;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  child(scope: string): Logger;
  isEnabled(level: EmittedLogLevel): boolean;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface ConsoleTarget {
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

interface LoggerOptions {
  readonly scope: string;
  readonly level: LogLevel;
  readonly sink: LogSink;
  readonly now?: () => Date;
  readonly includePrivateFields?: boolean;
  readonly includeStacks?: boolean;
}

const LEVEL_VALUE: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

const SENSITIVE_FIELD = /authorization|cookie|password|secret|token|api.?key/i;
const PRIVATE_FIELD =
  /path|cwd|directory|repo|root|prompt|message|content|title|reason|description|command|args|origin|host/i;
const STACK_FIELD = /stack/i;
const REDACTED = "[REDACTED]";
const PRIVATE = "[PRIVATE]";
const MAX_DEPTH = 6;

export function parseLogLevel(
  value: string | undefined,
  fallback: LogLevel,
): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "silent"
  ) {
    return normalized;
  }
  return fallback;
}

function sanitizeText(value: string, includePrivateText = false): string {
  const credentialsRedacted = value
    .replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /([?&](?:access_?token|auth|authorization|api_?key|secret|token)=)[^&\s]+/gi,
      `$1${REDACTED}`,
    );
  if (includePrivateText) return credentialsRedacted;
  return credentialsRedacted
    .replace(
      /(^|[\s(=])\/(?:[^/\s]+\/)+[^\s"'`,:;)]+/g,
      `$1${PRIVATE}`,
    )
    .replace(
      /\b[A-Za-z]:\\(?:Users\\)?[^\\\s]+(?:\\[^\s"'`,:;)]+)*/g,
      PRIVATE,
    );
}

interface SanitizeOptions {
  readonly includePrivateFields: boolean;
  readonly includeStacks: boolean;
}

function sanitizeValue(
  value: unknown,
  key: string,
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (SENSITIVE_FIELD.test(key)) return REDACTED;
  if (STACK_FIELD.test(key) && !options.includeStacks) return PRIVATE;
  if (PRIVATE_FIELD.test(key) && !options.includePrivateFields) return PRIVATE;
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeText(value, options.includePrivateFields);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (depth >= MAX_DEPTH) return "[MaxDepth]";

  if (value instanceof Error) {
    const sanitized: Record<string, unknown> = {
      name: sanitizeText(value.name, options.includePrivateFields),
      message: sanitizeText(value.message, options.includePrivateFields),
    };
    if (options.includeStacks && value.stack) {
      sanitized["stack"] = sanitizeText(
        value.stack,
        options.includePrivateFields,
      );
    }
    return sanitized;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeValue(item, key, options, seen, depth + 1),
    );
  }

  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = sanitizeValue(
      childValue,
      childKey,
      options,
      seen,
      depth + 1,
    );
  }
  return sanitized;
}

function sanitizeFields(
  fields: LogFields,
  options: SanitizeOptions,
): LogFields {
  try {
    return sanitizeValue(fields, "", options, new WeakSet(), 0) as LogFields;
  } catch {
    return { loggingError: "fields_unserializable" };
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const sanitizeOptions: SanitizeOptions = {
    includePrivateFields: options.includePrivateFields ?? false,
    includeStacks: options.includeStacks ?? false,
  };

  const isEnabled = (level: EmittedLogLevel): boolean =>
    LEVEL_VALUE[level] >= LEVEL_VALUE[options.level];

  const emit = (
    level: EmittedLogLevel,
    event: string,
    fields?: LogFields,
  ): void => {
    if (!isEnabled(level)) return;
    try {
      const base = {
        timestamp: now().toISOString(),
        level,
        scope: options.scope,
        event: sanitizeText(event),
      };
      const record: LogRecord = fields
        ? { ...base, fields: sanitizeFields(fields, sanitizeOptions) }
        : base;
      options.sink.write(record);
    } catch {
      // Logging must never alter application control flow.
    }
  };

  return {
    child: (scope) =>
      createLogger({
        ...options,
        scope: options.scope ? `${options.scope}:${scope}` : scope,
        now,
      }),
    isEnabled,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

export function createConsoleSink(target: ConsoleTarget): LogSink {
  return {
    write(record) {
      const label = `[${record.scope}] ${record.event}`;
      const args: unknown[] = record.fields ? [label, record.fields] : [label];
      target[record.level](...args);
    },
  };
}
