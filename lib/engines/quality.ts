import ts from "typescript";
import { createHash } from "node:crypto";
import type { QualityMetrics, RawFinding } from "../types";
import type { EngineContext } from "./shared";
import { findLine, isDocPath, isTestPath, makeFinding, matchLines, snippetAround } from "./shared";

interface FunctionInfo {
  path: string;
  name: string;
  line: number;
  endLine: number;
  lines: number;
  complexity: number;
  params: number;
  depth: number;
  language: string;
}

export interface QualityEngineResult {
  findings: RawFinding[];
  metrics: QualityMetrics;
  duplicateBlocks: { path: string; line: number; lines: number; occurrences: number }[];
}

const COMPLEXITY_NODES = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

const FUNCTION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

interface JsFileAnalysis {
  functions: FunctionInfo[];
  emptyCatches: number[];
  consoleLogs: number;
  tsIgnores: number;
  anyUsage: number;
}

function analyseJsFile(path: string, content: string): JsFileAnalysis {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false, scriptKindFor(path));
  const functions: FunctionInfo[] = [];
  const emptyCatches: number[] = [];
  let consoleLogs = 0;
  let tsIgnores = 0;
  let anyUsage = 0;

  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const computeFunction = (node: ts.Node) => {
    const startLine = lineOf(node);
    const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    let complexity = 1;
    let maxDepth = 0;

    const descend = (current: ts.Node, depth: number) => {
      if (COMPLEXITY_NODES.has(current.kind)) complexity += 1;
      if (current.kind === ts.SyntaxKind.BinaryExpression) {
        const operator = (current as ts.BinaryExpression).operatorToken.kind;
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity += 1;
        }
      }
      const nests =
        current.kind === ts.SyntaxKind.IfStatement ||
        current.kind === ts.SyntaxKind.ForStatement ||
        current.kind === ts.SyntaxKind.ForOfStatement ||
        current.kind === ts.SyntaxKind.ForInStatement ||
        current.kind === ts.SyntaxKind.WhileStatement ||
        current.kind === ts.SyntaxKind.DoStatement ||
        current.kind === ts.SyntaxKind.TryStatement ||
        current.kind === ts.SyntaxKind.SwitchStatement;
      const nextDepth = depth + (nests ? 1 : 0);
      if (nextDepth > maxDepth) maxDepth = nextDepth;
      current.forEachChild((child) => descend(child, nextDepth));
    };
    node.forEachChild((child) => descend(child, 0));

    const nameNode = (node as ts.NamedDeclaration).name;
    const name = nameNode && ts.isIdentifier(nameNode) ? nameNode.text : ts.isConstructorDeclaration(node) ? "constructor" : "<anonymous>";
    let params = 0;
    const callable = node as ts.SignatureDeclaration;
    if (callable.parameters) params = callable.parameters.length;

    functions.push({
      path,
      name,
      line: startLine,
      endLine,
      lines: endLine - startLine + 1,
      complexity,
      params,
      depth: Math.max(maxDepth, 1),
      language: scriptKindFor(path) === ts.ScriptKind.TS || scriptKindFor(path) === ts.ScriptKind.TSX ? "typescript" : "javascript",
    });
  };

  walk(source, (node) => {
    if (FUNCTION_KINDS.has(node.kind)) {
      computeFunction(node);
    }
    if (ts.isCatchClause(node)) {
      const block = node.block;
      if (block.statements.length === 0) emptyCatches.push(lineOf(node));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const text = node.expression.getText(source);
      if (text === "console.log" || text === "console.debug" || text === "console.info") consoleLogs += 1;
    }
    if (ts.isAsExpression(node) || ts.isTypeReferenceNode(node)) {
      if (node.getText(source) === "any") anyUsage += 1;
    }
  });

  // Suppression comments are not part of the AST.
  tsIgnores = (content.match(/@ts-(?:ignore|expect-error|nocheck)/g) ?? []).length;

  return { functions, emptyCatches, consoleLogs, tsIgnores, anyUsage };
}

function analysePythonFunctions(path: string, content: string): FunctionInfo[] {
  const lines = content.split("\n");
  const functions: FunctionInfo[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
    if (!match) continue;
    const indent = match[1]!.length;
    let end = index + 1;
    while (end < lines.length) {
      const row = lines[end]!;
      if (row.trim() && row.match(/^(\s*)/)![1]!.length <= indent) break;
      end += 1;
    }
    const body = lines.slice(index, end).join("\n");
    let complexity = 1;
    for (const keyword of body.match(/\b(?:if|elif|for|while|and|or|except|case)\b/g) ?? []) {
      if (keyword) complexity += 1;
    }
    let depth = 0;
    let maxDepth = 0;
    for (const row of lines.slice(index + 1, end)) {
      if (!row.trim()) continue;
      depth = Math.floor(row.match(/^(\s*)/)![1]!.length / 4);
      if (depth > maxDepth) maxDepth = depth;
    }
    functions.push({
      path,
      name: match[2]!,
      line: index + 1,
      endLine: end,
      lines: end - index,
      complexity,
      params: match[3]!.trim() ? match[3]!.split(",").length : 0,
      depth: maxDepth + 1,
      language: "python",
    });
  }
  return functions;
}

const DUP_WINDOW = 6;

function normaliseLine(line: string): string {
  return line
    .trim()
    .replace(/'(?:[^'\\]|\\.)*'/g, "'S'")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"S"')
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .replace(/\s+/g, " ");
}

function duplicateBlocks(files: { path: string; content: string; language: string }[]) {
  const windows = new Map<string, { path: string; line: number }[]>();
  for (const file of files) {
    const lines = file.content.split("\n").map(normaliseLine);
    for (let index = 0; index + DUP_WINDOW <= lines.length; index += 1) {
      const slice = lines.slice(index, index + DUP_WINDOW);
      if (slice.filter((row) => row.length > 2).length < DUP_WINDOW) continue;
      const key = createHash("sha1").update(slice.join("\n")).digest("hex");
      const list = windows.get(key) ?? [];
      if (list.length < 6) list.push({ path: file.path, line: index + 1 });
      windows.set(key, list);
    }
  }
  const blocks: { path: string; line: number; lines: number; occurrences: number }[] = [];
  const seenPaths = new Set<string>();
  for (const list of windows.values()) {
    if (list.length < 2) continue;
    const distinctFiles = new Set(list.map((item) => item.path));
    const first = list[0]!;
    const key = `${first.path}:${first.line}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    blocks.push({ path: first.path, line: first.line, lines: DUP_WINDOW, occurrences: Math.max(list.length, distinctFiles.size) });
    if (blocks.length >= 25) break;
  }
  return blocks;
}

export function runQualityEngine(ctx: EngineContext): QualityEngineResult {
  const findings: RawFinding[] = [];
  const functions: FunctionInfo[] = [];
  const skipDocs = ctx.files.filter((file) => !isDocPath(file.path) && !isTestPath(file.path));

  for (const file of ctx.files) {
    const content = file.content ?? "";
    if (!content) continue;
    const testPath = isTestPath(file.path);
    const isJs = ["javascript", "typescript"].includes(file.language);

    if (isJs) {
      const analysis = analyseJsFile(file.path, content);
      functions.push(...analysis.functions);
      for (const line of analysis.emptyCatches) {
        findings.push(
          makeFinding({
            ruleId: "QUA-004",
            path: file.path,
            line,
            snippet: snippetAround(content, line, 2),
            confidence: 0.88,
            toolReference: `quality-engine:${file.path}:${line}:empty-catch`,
          }),
        );
      }
      if (analysis.tsIgnores + analysis.anyUsage > 0 && file.language === "typescript") {
        const line = findLine(content, /@ts-(?:ignore|expect-error|nocheck)|:\s*any\b|as any\b/) ?? 1;
        findings.push(
          makeFinding({
            ruleId: "QUA-010",
            path: file.path,
            line,
            snippet: snippetAround(content, line, 2),
            confidence: 0.85,
            toolReference: `quality-engine:${file.path}:type-suppression`,
            metadata: { suppressions: analysis.tsIgnores, anyUsages: analysis.anyUsage },
          }),
        );
      }
      if (analysis.consoleLogs >= 3 && !testPath) {
        const line = findLine(content, /console\.(?:log|debug|info)/) ?? 1;
        findings.push(
          makeFinding({
            ruleId: "QUA-009",
            path: file.path,
            line,
            snippet: snippetAround(content, line, 1),
            confidence: 0.9,
            toolReference: `quality-engine:${file.path}:console`,
            metadata: { count: analysis.consoleLogs },
          }),
        );
      }
    } else if (file.language === "python") {
      const pythonFunctions = analysePythonFunctions(file.path, content);
      functions.push(...pythonFunctions);
      const printCount = (content.match(/^\s*print\s*\(/gm) ?? []).length;
      if (printCount >= 3 && !testPath) {
        const line = findLine(content, /^\s*print\s*\(/m) ?? 1;
        findings.push(
          makeFinding({
            ruleId: "QUA-009",
            path: file.path,
            line,
            snippet: snippetAround(content, line, 1),
            confidence: 0.85,
            toolReference: `quality-engine:${file.path}:print`,
            metadata: { count: printCount },
          }),
        );
      }
    }

    // Empty catch blocks in other languages.
    if (!isJs) {
      for (const match of matchLines(content, /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g, 10)) {
        findings.push(
          makeFinding({
            ruleId: "QUA-004",
            path: file.path,
            line: match.line,
            snippet: snippetAround(content, match.line, 1),
            confidence: 0.8,
            toolReference: `quality-engine:${file.path}:${match.line}:empty-catch`,
          }),
        );
      }
      for (const match of matchLines(content, /except\s+[A-Za-z.]*[^:]*:\s*pass\b/g, 10)) {
        findings.push(
          makeFinding({
            ruleId: "QUA-004",
            path: file.path,
            line: match.line,
            snippet: snippetAround(content, match.line, 2),
            confidence: 0.85,
            toolReference: `quality-engine:${file.path}:${match.line}:pass`,
          }),
        );
      }
    }

    // TODO/FIXME markers.
    const todoMatches = matchLines(content, /\b(?:TODO|FIXME|HACK|XXX)\b[:\s]/g, 6);
    if (todoMatches.length > 0) {
      findings.push(
        makeFinding({
          ruleId: "QUA-008",
          path: file.path,
          line: todoMatches[0]!.line,
          snippet: todoMatches
            .slice(0, 4)
            .map((match) => match.text.trim().slice(0, 160))
            .join("\n"),
          confidence: 0.95,
          toolReference: `quality-engine:${file.path}:todos`,
          metadata: { count: todoMatches.length },
        }),
      );
    }
  }

  // Per-file thresholds.
  for (const file of skipDocs) {
    if (file.loc > 600) {
      findings.push(
        makeFinding({
          ruleId: "QUA-005",
          path: file.path,
          line: 1,
          snippet: `${file.loc} logical lines`,
          confidence: 0.9,
          toolReference: `quality-engine:${file.path}:file-length`,
          metadata: { loc: file.loc },
        }),
      );
    }
  }

  // Per-function thresholds.
  for (const fn of functions) {
    const path = fn.path;
    const content = ctx.files.find((candidate) => candidate.path === path)?.content ?? "";
    if (isTestPath(path) || isDocPath(path)) continue;
    if (fn.lines > 60) {
      findings.push(
        makeFinding({
          ruleId: "QUA-001",
          path,
          line: fn.line,
          lineEnd: fn.endLine,
          symbol: fn.name,
          snippet: snippetAround(content, fn.line, 2),
          confidence: 0.95,
          toolReference: `quality-engine:${path}:${fn.line}:long-function`,
          metadata: { name: fn.name, lines: fn.lines },
        }),
      );
    }
    if (fn.complexity > 15) {
      findings.push(
        makeFinding({
          ruleId: "QUA-002",
          path,
          line: fn.line,
          lineEnd: fn.endLine,
          symbol: fn.name,
          snippet: snippetAround(content, fn.line, 2),
          confidence: 0.9,
          toolReference: `quality-engine:${path}:${fn.line}:complexity`,
          metadata: { name: fn.name, complexity: fn.complexity, language: fn.language },
        }),
      );
    }
    if (fn.params > 6) {
      findings.push(
        makeFinding({
          ruleId: "QUA-006",
          path,
          line: fn.line,
          symbol: fn.name,
          snippet: snippetAround(content, fn.line, 1),
          confidence: 0.85,
          toolReference: `quality-engine:${path}:${fn.line}:params`,
          metadata: { name: fn.name, params: fn.params },
        }),
      );
    }
    if (fn.depth > 5) {
      findings.push(
        makeFinding({
          ruleId: "QUA-007",
          path,
          line: fn.line,
          symbol: fn.name,
          snippet: snippetAround(content, fn.line, 2),
          confidence: 0.8,
          toolReference: `quality-engine:${path}:${fn.line}:nesting`,
          metadata: { name: fn.name, depth: fn.depth },
        }),
      );
    }
  }

  // Duplicated blocks across the project.
  const duplicates = duplicateBlocks(
    ctx.files
      .filter((file) => file.content && !isDocPath(file.path))
      .map((file) => ({ path: file.path, content: file.content ?? "", language: file.language })),
  );
  for (const block of duplicates) {
    const content = ctx.files.find((file) => file.path === block.path)?.content ?? "";
    findings.push(
      makeFinding({
        ruleId: "QUA-003",
        path: block.path,
        line: block.line,
        lineEnd: block.line + block.lines,
        snippet: snippetAround(content, block.line, 2),
        confidence: 0.8,
        toolReference: `quality-engine:${block.path}:${block.line}:duplicate`,
        metadata: { occurrences: block.occurrences, windowLines: block.lines },
      }),
    );
  }

  const metrics: QualityMetrics = {
    totalLoc: ctx.snapshot.totals.loc,
    files: ctx.snapshot.totals.textFileCount,
    avgFunctionLength: functions.length
      ? Number((functions.reduce((sum, fn) => sum + fn.lines, 0) / functions.length).toFixed(1))
      : 0,
    maxFunctionLength: functions.reduce((max, fn) => Math.max(max, fn.lines), 0),
    avgComplexity: functions.length
      ? Number((functions.reduce((sum, fn) => sum + fn.complexity, 0) / functions.length).toFixed(2))
      : 0,
    maxComplexity: functions.reduce((max, fn) => Math.max(max, fn.complexity), 0),
    duplicateBlocks: duplicates.length,
    duplicateLines: duplicates.reduce((sum, block) => sum + block.lines * (block.occurrences - 1), 0),
    functions: functions.length,
    filesOverThreshold: skipDocs.filter((file) => file.loc > 600).length,
    todoComments: findings.filter((finding) => finding.ruleId === "QUA-008").reduce(
      (sum, finding) => sum + Number((finding.metadata?.count as number) ?? 0),
      0,
    ),
    longParameterFunctions: functions.filter((fn) => fn.params > 6).length,
    emptyCatchBlocks: findings.filter((finding) => finding.ruleId === "QUA-004").length,
    deepNesting: functions.filter((fn) => fn.depth > 5).length,
  };

  return { findings, metrics, duplicateBlocks: duplicates };
}
