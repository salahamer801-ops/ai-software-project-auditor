import type { RawFinding } from "../types";
import type { EngineContext } from "./shared";
import { isDocPath, makeFinding, snippetAround } from "./shared";

/**
 * API auditor (§21). Static only: we read route definitions and their handler bodies.
 * We never send a request to the audited system.
 */

interface RouteDef {
  path: string;
  method: string;
  filePath: string;
  line: number;
  handlerStart: number;
  handlerEnd: number;
  handlerText: string;
  framework: string;
}

const AUTH_SIGNALS =
  /(auth|requireUser|requireAuth|getServerSession|getSession|currentUser|verifyToken|authenticate|authorize|permission|polic|can\(|Gate::|isAdmin|isOwner|req\.user|request\.user|@login_required|permission_classes|roles?\b|session\b|token)/i;
const VALIDATION_SIGNALS =
  /(zod|joi|yup|valibot|superstruct|validator|validate\s*\(|\.parse\(|\.safeParse\(|FormRequest|serializer|is_valid\(|@Valid|@validated|schema|checkSchema|express-validator|class-validator)/i;
const PUBLIC_PATHS = /(login|sign-?in|register|sign-?up|webhook|public|health|metrics|callback|reset|forgot|verify|token|openapi|docs)/i;
const SENSITIVE_RETURN = /(password|passwd|password_hash|secret|api_?key|token|ssn|credit_?card)/i;
const PAGINATION_SIGNALS = /(limit|offset|page|cursor|take\s*\(|paginate)/i;
const RATE_LIMIT_SIGNALS = /(rateLimit|rate_limit|throttle|limiter|ThrottleRequests|express-rate-limit|bottleneck)/i;

function extractBraceBody(lines: string[], startLine: number, maxLines = 120): { start: number; end: number } {
  let depth = 0;
  let started = false;
  const end = Math.min(lines.length, startLine + maxLines);
  for (let index = startLine - 1; index < end; index += 1) {
    const line = lines[index]!;
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") depth -= 1;
    }
    if (started && depth <= 0) return { start: startLine, end: index + 1 };
  }
  return { start: startLine, end };
}

function collectRoutes(ctx: EngineContext): RouteDef[] {
  const routes: RouteDef[] = [];

  for (const file of ctx.files) {
    const content = file.content ?? "";
    if (!content) continue;
    const lines = content.split("\n");
    const path = file.path;

    // Next.js App Router: app/**/route.ts with exported HTTP method handlers.
    if (/(^|\/)app\/.*route\.(ts|js|mjs)$/.test(path)) {
      const methodRegex = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
      let match: RegExpExecArray | null;
      while ((match = methodRegex.exec(content))) {
        const line = content.slice(0, match.index).split("\n").length;
        const body = extractBraceBody(lines, line, 200);
        routes.push({
          path: path.replace(/(^|\/)app\//, "/").replace(/\/route\.(ts|js|mjs)$/, "").replace(/\[([^\]]+)\]/g, ":$1") || "/",
          method: match[1]!,
          filePath: path,
          line,
          handlerStart: body.start,
          handlerEnd: body.end,
          handlerText: lines.slice(body.start - 1, body.end).join("\n"),
          framework: "Next.js route handler",
        });
      }
      continue;
    }

    // Next.js pages/api legacy handlers.
    if (/(^|\/)pages\/api\/.*\.(ts|js|mjs)$/.test(path)) {
      const body = extractBraceBody(lines, 1, 400);
      routes.push({
        path: path.replace(/(^|\/)pages/, "").replace(/\.(ts|js|mjs)$/, "").replace(/\/index$/, ""),
        method: "ANY",
        filePath: path,
        line: 1,
        handlerStart: 1,
        handlerEnd: body.end,
        handlerText: content,
        framework: "Next.js pages/api",
      });
      continue;
    }

    // Express / Fastify style routers.
    const routerRegex = /(?:router|app|server|fastify)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let routerMatch: RegExpExecArray | null;
    while ((routerMatch = routerRegex.exec(content))) {
      const line = content.slice(0, routerMatch.index).split("\n").length;
      const body = extractBraceBody(lines, line, 90);
      routes.push({
        path: routerMatch[2]!,
        method: routerMatch[1]!.toUpperCase(),
        filePath: path,
        line,
        handlerStart: body.start,
        handlerEnd: body.end,
        handlerText: lines.slice(body.start - 1, body.end).join("\n"),
        framework: "Express/Fastify route",
      });
    }

    // Laravel route files.
    if (/(^|\/)routes\/.*\.php$/.test(path)) {
      const laravelRegex = /Route::(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]([^;]*);/g;
      let laravelMatch: RegExpExecArray | null;
      while ((laravelMatch = laravelRegex.exec(content))) {
        const line = content.slice(0, laravelMatch.index).split("\n").length;
        routes.push({
          path: laravelMatch[2]!,
          method: laravelMatch[1]!.toUpperCase(),
          filePath: path,
          line,
          handlerStart: line,
          handlerEnd: Math.min(lines.length, line + 6),
          handlerText: lines.slice(line - 1, Math.min(lines.length, line + 6)).join("\n"),
          framework: "Laravel route",
        });
      }
    }

    // FastAPI decorators.
    const fastapiRegex = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
    let fastapiMatch: RegExpExecArray | null;
    while ((fastapiMatch = fastapiRegex.exec(content))) {
      const line = content.slice(0, fastapiMatch.index).split("\n").length;
      const end = Math.min(lines.length, line + 60);
      routes.push({
        path: fastapiMatch[2]!,
        method: fastapiMatch[1]!.toUpperCase(),
        filePath: path,
        line,
        handlerStart: line,
        handlerEnd: end,
        handlerText: lines.slice(line - 1, end).join("\n"),
        framework: "FastAPI route",
      });
    }

    // Django views.
    if (/views?\.py$/.test(path) || /urls\.py$/.test(path)) {
      const djangoRegex = /def\s+([a-z_][a-z0-9_]*)\(([^)]*request[^)]*)\)/g;
      let djangoMatch: RegExpExecArray | null;
      while ((djangoMatch = djangoRegex.exec(content))) {
        const line = content.slice(0, djangoMatch.index).split("\n").length;
        const indent = lines[line - 1]!.match(/^\s*/)![0].length;
        let end = line + 1;
        while (end < lines.length) {
          const row = lines[end]!;
          if (row.trim() && row.match(/^\s*/)![0].length <= indent) break;
          end += 1;
        }
        const handlerText = lines.slice(line - 1, end).join("\n");
        const preface = lines.slice(Math.max(0, line - 6), line).join("\n");
        routes.push({
          path: `/${djangoMatch[1]}`,
          method: /request\.method\s*==\s*['"]POST/i.test(handlerText) || /\bdef\s+post\b/.test(path) ? "POST" : "GET",
          filePath: path,
          line,
          handlerStart: line,
          handlerEnd: end,
          handlerText: `${preface}\n${handlerText}`,
          framework: "Django view",
        });
      }
    }
  }

  return routes;
}

export function runApiEngine(ctx: EngineContext): RawFinding[] {
  const findings: RawFinding[] = [];
  const routes = collectRoutes(ctx);
  const seen = new Set<string>();
  const emit = (finding: RawFinding) => {
    const key = `${finding.ruleId}:${finding.filePath}:${finding.lineStart ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  const authRouteFiles = new Set<string>();

  for (const route of routes) {
    if (isDocPath(route.filePath)) continue;
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(route.method);
    const publicRoute = PUBLIC_PATHS.test(route.path) || PUBLIC_PATHS.test(route.filePath);
    const hasAuth = AUTH_SIGNALS.test(route.handlerText) || AUTH_SIGNALS.test(route.filePath);

    if (mutating && !hasAuth && !publicRoute) {
      emit(
        makeFinding({
          ruleId: "API-001",
          path: route.filePath,
          line: route.line,
          lineEnd: route.handlerEnd,
          symbol: `${route.method} ${route.path}`,
          snippet: route.handlerText.split("\n").slice(0, 12).join("\n"),
          confidence: 0.6,
          toolReference: `api-engine:${route.framework}:${route.filePath}:${route.line}`,
          metadata: {
            method: route.method,
            routePath: route.path,
            framework: route.framework,
            note: "No authentication, ownership or role check was found in the handler body.",
          },
        }),
      );
    }

    const usesInput = /(req\.body|request\.body|request\.data|request\.POST|req\.query|req\.params|request\.get_json|request\.json|request\.form|params\[)/.test(
      route.handlerText,
    );
    if (usesInput && !VALIDATION_SIGNALS.test(route.handlerText)) {
      emit(
        makeFinding({
          ruleId: "API-002",
          path: route.filePath,
          line: route.line,
          lineEnd: route.handlerEnd,
          symbol: `${route.method} ${route.path}`,
          snippet: route.handlerText.split("\n").slice(0, 10).join("\n"),
          confidence: 0.6,
          toolReference: `api-engine:validation:${route.filePath}:${route.line}`,
          metadata: { method: route.method, routePath: route.path, framework: route.framework },
        }),
      );
    }

    if (/(?:res|response|reply)\.(?:status\(\d+\)\.)?(?:json|send|end)\([^)]*(?:err|error)\.(?:message|stack)|raise\s+\w*Error\(\s*str\(e\)|jsonify\(\s*\{[^}]*error[^}]*\}/.test(
      route.handlerText,
    )) {
      emit(
        makeFinding({
          ruleId: "API-003",
          path: route.filePath,
          line: route.line,
          lineEnd: route.handlerEnd,
          symbol: `${route.method} ${route.path}`,
          snippet: route.handlerText.split("\n").slice(0, 12).join("\n"),
          confidence: 0.7,
          toolReference: `api-engine:error-leak:${route.filePath}:${route.line}`,
          metadata: { method: route.method, routePath: route.path },
        }),
      );
    }

    if (
      /(?:res|response)\.(?:json|send)\(\s*(?:rows?|users?|user|account|data|result|results)\s*\)/.test(route.handlerText) &&
      SENSITIVE_RETURN.test(route.handlerText)
    ) {
      emit(
        makeFinding({
          ruleId: "API-005",
          path: route.filePath,
          line: route.line,
          lineEnd: route.handlerEnd,
          symbol: `${route.method} ${route.path}`,
          snippet: route.handlerText.split("\n").slice(0, 14).join("\n"),
          confidence: 0.7,
          toolReference: `api-engine:field-exposure:${route.filePath}:${route.line}`,
          metadata: { method: route.method, routePath: route.path },
        }),
      );
    }

    const listLike =
      /(?:find\(|findAll\(|select\s+\*\s+from|\.all\(\)|getAll|index\b)/i.test(route.handlerText) && route.method === "GET";
    if (listLike && !PAGINATION_SIGNALS.test(route.handlerText)) {
      emit(
        makeFinding({
          ruleId: "API-006",
          path: route.filePath,
          line: route.line,
          lineEnd: route.handlerEnd,
          symbol: `${route.method} ${route.path}`,
          snippet: route.handlerText.split("\n").slice(0, 10).join("\n"),
          confidence: 0.6,
          toolReference: `api-engine:pagination:${route.filePath}:${route.line}`,
          metadata: { method: route.method, routePath: route.path },
        }),
      );
    }

    if (PUBLIC_PATHS.test(route.path) && /(login|register|signin|signup|otp|verify|reset|forgot)/i.test(route.path)) {
      authRouteFiles.add(route.filePath);
    }
  }

  for (const filePath of authRouteFiles) {
    const content = ctx.files.find((file) => file.path === filePath)?.content ?? "";
    if (RATE_LIMIT_SIGNALS.test(content)) continue;
    emit(
      makeFinding({
        ruleId: "API-004",
        path: filePath,
        line: 1,
        snippet: snippetAround(content, 1, 3),
        confidence: 0.55,
        toolReference: `api-engine:rate-limit:${filePath}`,
        metadata: { note: "No throttling middleware found in the file that defines the auth routes." },
      }),
    );
  }

  return findings;
}
