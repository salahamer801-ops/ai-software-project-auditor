/**
 * Dependency-free structured logging.
 *
 * Every call writes exactly ONE JSON line to stdout: `{ ts, level, event, ...fields }`.
 * The shape is stable so a log shipper can index `event`, `route`, `requestId`, `status`.
 *
 * Level rule (the whole rule, nothing per-module): `LOG_LEVEL` wins when it is one of
 * debug|info|warn|error; otherwise the level is "debug" outside production and "info"
 * in production. So development is verbose by default and production stays quiet
 * unless LOG_LEVEL asks for more.
 *
 * Safety: the logger never throws and never prints a raw error object or a secret.
 * Field values are sanitised before serialisation — secret-ish keys are redacted,
 * long strings are truncated, arrays are capped, `Error` becomes `{ name, message }`
 * (never a stack) and nested plain objects are walked one level deep at most.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose *value* must never reach a log line. */
const SECRET_KEY_RE = /secret|token|password|passwd|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;

const REDACTED = "[redacted]";
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ITEMS = 20;
const MAX_EVENT_LENGTH = 120;
const MAX_DEPTH = 1;

function truncate(value: string, max = MAX_STRING_LENGTH): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Turns any value into something safe to serialise.
 * `depth` counts how deep we already are below a top-level field: at MAX_DEPTH
 * anything object-like collapses to "[object]" so a cyclic graph can never hang us.
 */
function sanitize(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Error) return { name: value.name, message: truncate(value.message) };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }
  if (typeof value === "object") {
    if (depth > MAX_DEPTH) return "[object]";
    const out: Record<string, unknown> = {};
    try {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SECRET_KEY_RE.test(key) ? REDACTED : sanitize(item, depth + 1);
      }
    } catch {
      return "[object]";
    }
    return out;
  }
  return String(value);
}

function sanitizeFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    try {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : sanitize(value, 1);
    } catch {
      out[key] = "[unloggable]";
    }
  }
  return out;
}

function minLevel(): LogLevel {
  const raw = typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined;
  const configured = raw?.trim().toLowerCase();
  if (configured && Object.prototype.hasOwnProperty.call(LEVEL_WEIGHT, configured)) {
    return configured as LogLevel;
  }
  return typeof process !== "undefined" && process.env.NODE_ENV === "production" ? "info" : "debug";
}

function enabled(level: LogLevel): boolean {
  if (level === "debug") {
    // Cheap short-circuit so debug call sites stay free in production.
    const configured = typeof process !== "undefined" ? process.env.LOG_LEVEL?.trim().toLowerCase() : undefined;
    if (!configured && typeof process !== "undefined" && process.env.NODE_ENV === "production") return false;
  }
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[minLevel()];
}

function write(line: string): void {
  try {
    const stdout = typeof process !== "undefined" ? process.stdout : undefined;
    if (stdout && typeof stdout.write === "function") {
      stdout.write(line);
      return;
    }
  } catch {
    /* fall through to console */
  }
  try {
    // eslint-disable-next-line no-console
    console.log(line.trimEnd());
  } catch {
    /* logging must never break a request */
  }
}

/** One JSON line to stdout. Never throws, never prints a secret. */
export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  try {
    if (!enabled(level)) return;
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event: truncate(typeof event === "string" ? event : String(event), MAX_EVENT_LENGTH),
      ...sanitizeFields(fields),
    };
    write(`${JSON.stringify(payload)}\n`);
  } catch {
    /* logging must never break a request */
  }
}

/** Short correlation id; prefers the platform's UUID generator, falls back to randomness. */
export function newRequestId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid.replace(/-/g, "").slice(0, 16);
  } catch {
    /* fall through */
  }
  return `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Runs `fn`, logging one line with `durationMs` when it settles.
 * On throw it logs level "error" with the sanitised error and re-throws unchanged.
 */
export async function withSpan<T>(
  event: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    log("info", event, { ...fields, status: "ok", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    log("error", event, { ...fields, status: "error", durationMs: Date.now() - startedAt, error });
    throw error;
  }
}

/** Convenience wrappers: `logger.info("event", { field: value })`. */
export const logger = {
  debug: (event: string, fields?: Record<string, unknown>): void => log("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>): void => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>): void => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>): void => log("error", event, fields),
};
