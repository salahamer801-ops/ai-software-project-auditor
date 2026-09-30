/**
 * The API route layer: one wrapper, one error shape, one set of validators.
 *
 * Every handler under `app/api/**` is exported through `withRoute`, which owns the
 * request id, the `api.request` / `api.response` log lines and the mapping of thrown
 * errors to a stable JSON body. Routes keep their own status codes and field names —
 * the browser code in `components/*` reads them — this layer only guarantees that a
 * thrown error never leaks a stack trace or a database message to the client.
 *
 * Error body (the shape the UI already tolerates):
 *   { "error": "<code>", "code": "<code>", "message": "<human text>", "requestId": "<id>" }
 * `error` stays the machine code because that is what the existing UI maps to its
 * dictionary (`invalid_credentials`, `too_large`, …); `message` is for humans, and
 * `requestId` lets a report be traced back to the log lines. `details` is added only
 * when an error carries one (validation fields).
 */

import { ArchiveError } from "@/lib/sources/extract";
import { GithubError } from "@/lib/sources/github";
import { log, newRequestId } from "@/lib/observability/log";

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Short human text per code: Arabic first, then English, so one string serves both. */
export const ERROR_MESSAGES: Record<string, string> = {
  bad_origin: "طلب من أصل غير موثوق — Request from an untrusted origin",
  unauthorized: "الجلسة منتهية أو غير صالحة — Session missing or expired",
  forbidden: "لا تملك صلاحية لهذا الإجراء — You are not allowed to do this",
  not_found: "العنصر غير موجود — Not found",
  job_not_found: "التدقيق غير موجود — The audit job does not exist",
  project_not_found: "المشروع غير موجود — The project does not exist",
  invalid_credentials: "بيانات الدخول غير صحيحة — Invalid email or password",
  rate_limited: "محاولات كثيرة جدًا — Too many attempts, try again later",
  email_taken: "هذا البريد مسجَّل بالفعل — This email is already registered",
  invalid_email: "بريد إلكتروني غير صالح — Invalid email address",
  weak_password: "كلمة المرور قصيرة (8 أحرف على الأقل) — Password must be at least 8 characters",
  name_required: "الاسم مطلوب — A name is required",
  invalid_repo: "رابط المستودع غير صالح — Invalid repository URL",
  invalid_archive: "الملف ليس أرشيفًا صالحًا — The file is not a valid archive",
  archive_invalid: "تعذّر قراءة الأرشيف — The archive could not be read",
  too_large: "الحجم أكبر من الحد المسموح — File exceeds the size limit",
  payload_too_large: "حجم الطلب أكبر من الحد المسموح — Request body exceeds the limit",
  unsupported_media_type: "نوع المحتوى غير مدعوم — Unsupported content type",
  invalid_json: "صيغة JSON غير صالحة — Malformed JSON body",
  invalid_field: "قيمة غير صالحة — Invalid value",
  invalid_status: "حالة غير معروفة — Unknown status",
  invalid_locale: "لغة غير مدعومة — Unsupported locale",
  report_not_ready: "التقرير غير جاهز بعد — The report is not ready yet",
  github_error: "تعذّر الوصول إلى GitHub — GitHub could not be reached",
  internal_error: "حدث خطأ غير متوقع — An unexpected error occurred",
};

export function httpError(status: number, code: string, message?: string, details?: unknown): ApiError {
  return new ApiError(status, code, message ?? ERROR_MESSAGES[code] ?? code, details);
}

/* ------------------------------------------------------------------ */
/* Route metadata                                                     */
/* ------------------------------------------------------------------ */

export type ApiRouteCtx<TExtra extends Record<string, unknown>> = { params: Promise<TExtra> };
export type ApiRouteMeta = { requestId: string };
export type ApiRouteHandler<TExtra extends Record<string, unknown>> = (
  req: Request,
  ctx: ApiRouteCtx<TExtra>,
  meta: ApiRouteMeta,
) => Promise<Response>;

interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  /** true = we could not explain it; log at error level, never show the original text. */
  unexpected: boolean;
}

function numericStatus(error: object): number | null {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) && status >= 400 && status < 600 ? status : null;
}

function mapError(error: unknown): MappedError {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details, unexpected: false };
  }
  // A bad or unreadable upload archive is the client's problem, not a server fault.
  if (error instanceof ArchiveError) {
    return { status: 400, code: "archive_invalid", message: ERROR_MESSAGES.archive_invalid!, unexpected: false };
  }
  // GitHub ingestion: keep a status the error carries itself, otherwise report 502.
  if (error instanceof GithubError) {
    return {
      status: numericStatus(error) ?? 502,
      code: "github_error",
      message: ERROR_MESSAGES.github_error!,
      details: { githubCode: error.code },
      unexpected: false,
    };
  }
  // No AuthError class exists in lib/auth.ts in this version: session failures are
  // returned explicitly by each route as 401 "unauthorized" so the UI keeps its code.
  return { status: 500, code: "internal_error", message: ERROR_MESSAGES.internal_error!, unexpected: true };
}

export function errorBody(mapped: MappedError, requestId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: mapped.code,
    code: mapped.code,
    message: mapped.message,
    requestId,
  };
  if (mapped.details !== undefined) body.details = mapped.details;
  return body;
}

function attachRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set("x-request-id", requestId);
  } catch {
    /* headers from an upstream fetch can be immutable — never fatal */
  }
  return response;
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}

/**
 * Wraps a route handler with request-id handling, structured logs and error mapping.
 * The returned function matches Next.js' expected route handler signature (`ctx.params`
 * stays a promise) and always resolves to a `Response`.
 */
export function withRoute<TExtra extends Record<string, unknown> = Record<string, never>>(
  name: string,
  handler: ApiRouteHandler<TExtra>,
): (request: Request, context: { params: Promise<TExtra> }) => Promise<Response> {
  return async (request: Request, context: { params: Promise<TExtra> }): Promise<Response> => {
    const startedAt = Date.now();
    const incoming = request.headers.get("x-request-id")?.trim().slice(0, 64);
    const requestId = incoming || newRequestId();
    const method = request.method || "GET";
    const path = requestPath(request);

    log("info", "api.request", { requestId, route: name, method, path });

    try {
      const params = context?.params ?? Promise.resolve({} as TExtra);
      const response = await handler(request, { params }, { requestId });
      const withId = attachRequestId(response, requestId);
      log("info", "api.response", {
        requestId,
        route: name,
        method,
        path,
        status: withId.status,
        durationMs: Date.now() - startedAt,
      });
      return withId;
    } catch (error) {
      const mapped = mapError(error);
      log(mapped.unexpected ? "error" : "warn", "api.error", {
        requestId,
        route: name,
        method,
        path,
        status: mapped.status,
        code: mapped.code,
        durationMs: Date.now() - startedAt,
        error,
      });
      return Response.json(errorBody(mapped, requestId), {
        status: mapped.status,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Body reading                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const JSON_CONTENT_TYPE_RE = /^application\/(?:[\w.+-]+\+)?json\b|^text\/json\b/i;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Reads and parses a JSON body.
 *
 * Tolerance that the existing clients rely on: an empty body returns `{}` instead of
 * failing (several buttons POST with no body at all), and a request that declares no
 * content type is parsed as JSON. A body that *declares* a non-JSON content type is
 * rejected with 415, an oversized one with 413, malformed JSON with 400.
 */
export async function readJson<T>(req: Request, opts: { maxBytes?: number } = {}): Promise<T> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;

  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw httpError(413, "payload_too_large");
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    throw httpError(400, "invalid_json");
  }
  if (!text.trim()) return {} as T;
  if (byteLength(text) > maxBytes) throw httpError(413, "payload_too_large");

  const contentType = (req.headers.get("content-type") ?? "").trim();
  if (contentType && !JSON_CONTENT_TYPE_RE.test(contentType)) {
    throw httpError(415, "unsupported_media_type");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw httpError(400, "invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
  return parsed as T;
}

/** Empty 204 with no-store headers, for endpoints that only acknowledge a request. */
export function noStore(headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store, max-age=0, must-revalidate", ...headers },
  });
}

/* ------------------------------------------------------------------ */
/* Validators                                                         */
/* ------------------------------------------------------------------ */

function invalid(code: string | undefined, message: string | undefined, field: string): ApiError {
  const resolved = code ?? "invalid_field";
  return httpError(400, resolved, message ?? `Invalid value for "${field}"`, { field });
}

export interface StrOptions {
  field: string;
  min?: number;
  max?: number;
  optional?: boolean;
  trim?: boolean;
  lower?: boolean;
  /** Clamp to `max` instead of failing — the behaviour some routes already had. */
  clamp?: boolean;
  code?: string;
  message?: string;
}

export function str(value: unknown, opts: StrOptions & { optional: true }): string | undefined;
export function str(value: unknown, opts: StrOptions): string;
export function str(value: unknown, opts: StrOptions): string | undefined {
  const { field, min, max, optional, trim, lower, clamp, code, message } = opts;
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw invalid(code, message, field);
  }
  if (typeof value !== "string") {
    if (optional) return undefined;
    throw invalid(code, message, field);
  }
  let out = value;
  if (trim) out = out.trim();
  if (lower) out = out.toLowerCase();
  if (max !== undefined && out.length > max) {
    if (clamp) out = out.slice(0, max);
    else throw invalid(code, message, field);
  }
  if (min !== undefined && out.length < min) throw invalid(code, message, field);
  return out;
}

export interface OneOfOptions {
  optional?: boolean;
  code?: string;
  message?: string;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  opts: OneOfOptions & { optional: true },
): T | undefined;
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  opts?: OneOfOptions,
): T;
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  opts: OneOfOptions = {},
): T | undefined {
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return undefined;
    throw invalid(opts.code, opts.message, field);
  }
  const match = typeof value === "string" ? allowed.find((candidate) => candidate === value) : undefined;
  if (match === undefined) throw invalid(opts.code, opts.message, field);
  return match;
}

export interface IntOptions {
  field: string;
  min?: number;
  max?: number;
  optional?: boolean;
  code?: string;
  message?: string;
}

export function int(value: unknown, opts: IntOptions & { optional: true }): number | undefined;
export function int(value: unknown, opts: IntOptions): number;
export function int(value: unknown, opts: IntOptions): number | undefined {
  const { field, min, max, optional, code, message } = opts;
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw invalid(code, message, field);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw invalid(code, message, field);
  if (min !== undefined && parsed < min) throw invalid(code, message, field);
  if (max !== undefined && parsed > max) throw invalid(code, message, field);
  return parsed;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmailOptions {
  code?: string;
  message?: string;
  /** Cloud the address is stored at; longer input is clamped, as the routes always did. */
  max?: number;
}

/** Validated, trimmed, lower-cased email — throws 400 `invalid_email` by default. */
export function email(value: unknown, field: string, opts: EmailOptions = {}): string {
  const max = opts.max ?? 200;
  let candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (candidate.length > max) candidate = candidate.slice(0, max);
  if (!EMAIL_RE.test(candidate)) {
    throw httpError(400, opts.code ?? "invalid_email", opts.message ?? `Invalid value for "${field}"`, { field });
  }
  return candidate;
}
