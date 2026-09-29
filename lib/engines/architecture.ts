import type { ArchitectureSummary, RawFinding } from "../types";
import type { EngineContext } from "./shared";
import { isDocPath, isUiFile, makeFinding, snippetAround } from "./shared";

/**
 * Architecture engine (§20): an import graph built from source text, then cycles,
 * coupling and layer violations derived from it.
 */

export interface ArchitectureEngineResult {
  findings: RawFinding[];
  summary: ArchitectureSummary;
}

const DB_PACKAGES = [
  "@prisma/client",
  "prisma",
  "pg",
  "mysql2",
  "mysql",
  "mongoose",
  "sequelize",
  "typeorm",
  "knex",
  "drizzle-orm",
  "better-sqlite3",
  "sqlite3",
  "mongodb",
  "ioredis",
  "redis",
];

const RELATIVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
  ".php",
  ".rb",
  ".dart",
  ".go",
  ".java",
  ".cs",
];

interface ImportRef {
  specifier: string;
  line: number;
}

export function extractImports(path: string, content: string, language: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = content.split("\n");
  const push = (specifier: string, line: number) => {
    if (!specifier) return;
    refs.push({ specifier, line });
  };

  if (["javascript", "typescript"].includes(language)) {
    lines.forEach((line, index) => {
      const from = line.match(/(?:^|\s)(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/);
      if (from) push(from[1]!, index + 1);
      const bare = line.match(/^\s*import\s*['"]([^'"]+)['"]/);
      if (bare) push(bare[1]!, index + 1);
      const requires = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
      if (requires) {
        for (const call of requires) {
          const value = call.match(/['"]([^'"]+)['"]/);
          if (value) push(value[1]!, index + 1);
        }
      }
      const dynamic = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (dynamic) push(dynamic[1]!, index + 1);
    });
  } else if (language === "python") {
    lines.forEach((line, index) => {
      const fromImport = line.match(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/);
      if (fromImport && !fromImport[1]!.startsWith(".")) push(fromImport[1]!, index + 1);
      else if (fromImport) {
        const dots = fromImport[1]!.match(/^\.+/)?.[0].length ?? 1;
        push(`${".".repeat(dots)}${fromImport[1]!.replace(/^\.+/, "")}`, index + 1);
      }
      const plain = line.match(/^\s*import\s+([A-Za-z0-9_.,\s]+)$/);
      if (plain) {
        for (const name of plain[1]!.split(",").map((item) => item.trim()).filter(Boolean)) {
          if (!name.includes(" as ")) push(name, index + 1);
        }
      }
    });
  } else if (language === "php") {
    lines.forEach((line, index) => {
      const use = line.match(/^\s*use\s+([A-Za-z0-9_\\]+)/);
      if (use) push(use[1]!, index + 1);
      const require = line.match(/(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/);
      if (require) push(require[1]!, index + 1);
    });
  } else if (language === "ruby") {
    lines.forEach((line, index) => {
      const req = line.match(/^\s*require(?:_relative)?\s*['"]([^'"]+)['"]/);
      if (req) push(req[1]!, index + 1);
    });
  } else if (language === "dart") {
    lines.forEach((line, index) => {
      const imp = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
      if (imp) push(imp[1]!, index + 1);
    });
  } else if (language === "go") {
    let inBlock = false;
    lines.forEach((line, index) => {
      if (/^\s*import\s*\(/.test(line)) {
        inBlock = true;
        return;
      }
      if (inBlock && /^\s*\)/.test(line)) {
        inBlock = false;
        return;
      }
      if (inBlock) {
        const match = line.match(/^\s*(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/);
        if (match) push(match[1]!, index + 1);
      } else {
        const single = line.match(/^\s*import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/);
        if (single) push(single[1]!, index + 1);
      }
    });
  } else if (language === "java" || language === "kotlin") {
    lines.forEach((line, index) => {
      const imp = line.match(/^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+)/);
      if (imp) push(imp[1]!, index + 1);
    });
  } else if (language === "csharp") {
    lines.forEach((line, index) => {
      const use = line.match(/^\s*using\s+([A-Za-z0-9_.]+)\s*;/);
      if (use) push(use[1]!, index + 1);
    });
  }

  return refs;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function resolveRelative(fromPath: string, specifier: string, fileSet: Set<string>): string | null {
  const base = dirOf(fromPath);
  const stack = base ? base.split("/") : [];
  const parts = specifier.split("/");
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const candidateBase = stack.join("/");
  const candidates = [candidateBase, ...RELATIVE_EXTENSIONS.map((ext) => `${candidateBase}${ext}`)];
  for (const ext of RELATIVE_EXTENSIONS) {
    candidates.push(`${candidateBase}/index${ext}`);
    candidates.push(`${candidateBase}/__init__.py`);
  }
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  if (candidateBase.endsWith(".php")) {
    const phpCandidate = `${candidateBase}`;
    if (fileSet.has(phpCandidate)) return phpCandidate;
  }
  return null;
}

function resolveModule(path: string, specifier: string, language: string, fileSet: Set<string>): string | null {
  if (specifier.startsWith(".")) return resolveRelative(path, specifier, fileSet);
  if (language === "python") {
    const modulePath = specifier.replace(/\./g, "/");
    const candidates = [`${modulePath}.py`, `${modulePath}/__init__.py`];
    for (const candidate of candidates) {
      if (fileSet.has(candidate)) return candidate;
    }
    for (const candidate of fileSet) {
      if (candidate.endsWith(`/${modulePath}.py`) || candidate.endsWith(`/${modulePath}/__init__.py`)) return candidate;
    }
    return null;
  }
  if (language === "php") {
    const modulePath = specifier.replace(/\\/g, "/");
    const lowered = fileSet;
    for (const candidate of lowered) {
      if (candidate.toLowerCase().endsWith(`${modulePath.toLowerCase()}.php`)) return candidate;
    }
    return null;
  }
  if (language === "dart" && specifier.startsWith("package:")) return null;
  return null;
}

export function runArchitectureEngine(ctx: EngineContext): ArchitectureEngineResult {
  const findings: RawFinding[] = [];
  const files = ctx.files.filter((file) => file.content && !isDocPath(file.path));
  const fileSet = new Set(files.map((file) => file.path));
  const fileByPath = new Map(files.map((file) => [file.path, file]));

  const edges: { source: string; target: string; line: number }[] = [];
  const externalCount = new Map<string, number>();

  for (const file of files) {
    const refs = extractImports(file.path, file.content ?? "", file.language);
    const seenTargets = new Set<string>();
    for (const ref of refs) {
      const target = resolveModule(file.path, ref.specifier, file.language, fileSet);
      if (!target || target === file.path) {
        if (!ref.specifier.startsWith(".")) {
          externalCount.set(ref.specifier, (externalCount.get(ref.specifier) ?? 0) + 1);
        }
        continue;
      }
      const key = `${file.path}->${target}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      edges.push({ source: file.path, target, line: ref.line });
    }
  }

  // --- cycles ---------------------------------------------------------
  const adjacency = new Map<string, { target: string; line: number }[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? [];
    list.push({ target: edge.target, line: edge.line });
    adjacency.set(edge.source, list);
  }

  const cycles: string[][] = [];
  const seenCycles = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const edge of adjacency.get(node) ?? []) {
      const next = edge.target;
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        const index = stack.indexOf(next);
        if (index >= 0) {
          const cycle = stack.slice(index);
          if (cycle.length > 1 && cycle.length <= 12) {
            const key = [...cycle].sort().join("|");
            if (!seenCycles.has(key)) {
              seenCycles.add(key);
              cycles.push(cycle);
            }
          }
        }
      } else if (nextState === 0) {
        visit(next);
      }
      if (cycles.length > 20) break;
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of adjacency.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
    if (cycles.length > 20) break;
  }

  for (const cycle of cycles.slice(0, 15)) {
    const first = cycle[0]!;
    const edge = (adjacency.get(first) ?? []).find((candidate) => candidate.target === cycle[cycle.length - 1] || cycle.includes(candidate.target));
    const content = fileByPath.get(first)?.content ?? "";
    findings.push(
      makeFinding({
        ruleId: "ARC-001",
        path: first,
        line: edge?.line ?? 1,
        snippet: snippetAround(content, edge?.line ?? 1, 2),
        confidence: 0.9,
        toolReference: `architecture-engine:cycle:${cycle.join(" -> ")}`,
        metadata: { cycle, length: cycle.length },
        extraEvidence: [
          {
            sourceType: "tool_output" as const,
            sourceReference: "dependency graph cycle",
            snippet: cycle.join(" → "),
          },
        ],
      }),
    );
  }

  // --- coupling --------------------------------------------------------
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  for (const edge of edges) {
    fanOut.set(edge.source, (fanOut.get(edge.source) ?? 0) + 1);
    fanIn.set(edge.target, (fanIn.get(edge.target) ?? 0) + 1);
  }

  const coupled = files
    .map((file) => {
      const out = fanOut.get(file.path) ?? 0;
      const incoming = fanIn.get(file.path) ?? 0;
      const instability = out + incoming === 0 ? 0 : Number((out / (out + incoming)).toFixed(2));
      return { path: file.path, fanIn: incoming, fanOut: out, instability };
    })
    .filter((node) => node.fanOut >= 8 || node.fanIn >= 10)
    .sort((a, b) => b.fanOut + b.fanIn - (a.fanOut + a.fanIn))
    .slice(0, 8);

  for (const node of coupled.slice(0, 5)) {
    const content = fileByPath.get(node.path)?.content ?? "";
    findings.push(
      makeFinding({
        ruleId: "ARC-002",
        path: node.path,
        line: 1,
        snippet: snippetAround(content, 1, 1),
        confidence: 0.75,
        toolReference: `architecture-engine:coupling:${node.path}`,
        metadata: node,
      }),
    );
  }

  // --- layer violations ------------------------------------------------
  const layerViolations: { from: string; to: string; rule: string }[] = [];
  for (const file of files) {
    if (!isUiFile(file.path)) continue;
    const refs = extractImports(file.path, file.content ?? "", file.language);
    for (const ref of refs) {
      const root = ref.specifier.startsWith("@") ? ref.specifier.split("/").slice(0, 2).join("/") : ref.specifier.split("/")[0]!;
      if (DB_PACKAGES.includes(root) || DB_PACKAGES.includes(ref.specifier)) {
        layerViolations.push({ from: file.path, to: ref.specifier, rule: "ui-imports-data-layer" });
        findings.push(
          makeFinding({
            ruleId: "ARC-003",
            path: file.path,
            line: ref.line,
            snippet: snippetAround(file.content ?? "", ref.line, 1),
            confidence: 0.65,
            toolReference: `architecture-engine:layer:${file.path}:${ref.specifier}`,
            metadata: { importedPackage: ref.specifier, layer: "ui" },
          }),
        );
        break;
      }
    }
  }

  // --- oversized modules -----------------------------------------------
  const oversized = files
    .filter((file) => file.loc > 800)
    .map((file) => ({ path: file.path, loc: file.loc }))
    .slice(0, 6);
  for (const module of oversized) {
    findings.push(
      makeFinding({
        ruleId: "ARC-004",
        path: module.path,
        line: 1,
        snippet: `${module.loc} logical lines in one module`,
        confidence: 0.85,
        toolReference: `architecture-engine:size:${module.path}`,
        metadata: module,
      }),
    );
  }

  const summary: ArchitectureSummary = {
    nodes: files.length,
    edges: edges.length,
    cycles: cycles.slice(0, 15).map((path) => ({ path, length: path.length })),
    highlyCoupled: coupled,
    layerViolations,
    oversizedModules: oversized,
    graph: edges.slice(0, 400).map((edge) => ({ source: edge.source, target: edge.target })),
  };

  return { findings, summary };
}
