import type { RawFinding } from "../types";
import type { EngineContext } from "./shared";
import { isDocPath, isTestPath, makeFinding, matchLines, snippetAround } from "./shared";

/**
 * Database auditor (§22): migrations, schema files and raw queries — no connection to
 * any customer database is ever opened.
 */

interface TableColumn {
  table: string;
  column: string;
  line: number;
  isForeignKey: boolean;
  isIdentity: boolean;
  hasUnique: boolean;
  hasIndex: boolean;
}

const IDENTITY_COLUMNS = /(email|username|user_name|phone|mobile|slug|handle|national_?id|tax_?id)/i;

function parseSqlSchema(path: string, content: string): { columns: TableColumn[]; indexes: Set<string>; drops: number[] } {
  const columns: TableColumn[] = [];
  const indexes = new Set<string>();
  const drops: number[] = [];
  const lines = content.split("\n");

  let currentTable: string | null = null;
  const inlineUniqueTables = new Set<string>();

  lines.forEach((line, index) => {
    const create = line.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`']?([A-Za-z0-9_]+)["`']?\s*\(/i);
    if (create) {
      currentTable = create[1]!.toLowerCase();
      if (/unique/i.test(line)) inlineUniqueTables.add(currentTable);
      return;
    }
    if (currentTable && /^\s*\);/.test(line)) {
      currentTable = null;
      return;
    }
    if (/create\s+(?:unique\s+)?index/i.test(line)) {
      const match = line.match(/on\s+["`']?([A-Za-z0-9_]+)["`']?\s*\(([^)]+)\)/i);
      if (match) {
        for (const column of match[2]!.split(",")) {
          indexes.add(`${match[1]!.toLowerCase()}.${column.replace(/["`']/g, "").trim().toLowerCase()}`);
        }
      }
      return;
    }
    if (/^\s*(?:alter\s+table|drop\s+table)/i.test(line) && /drop\s+(?:table|column)/i.test(line)) {
      drops.push(index + 1);
    }
    if (!currentTable) return;

    const columnMatch = line.match(/^\s*["`']?([A-Za-z0-9_]+)["`']?\s+([A-Za-z0-9_()[\],\s]+)/);
    if (!columnMatch) return;
    const name = columnMatch[1]!.toLowerCase();
    if (["constraint", "primary", "foreign", "unique", "key", "check"].includes(name)) {
      if (name === "unique") {
        const uniqueMatch = line.match(/unique\s*\(([^)]+)\)/i);
        if (uniqueMatch) {
          for (const column of uniqueMatch[1]!.split(",")) {
            indexes.add(`${currentTable}.${column.trim().replace(/["`']/g, "").toLowerCase()}`);
          }
        }
      }
      if (name === "foreign") {
        const fk = line.match(/foreign\s+key\s*\(([^)]+)\)/i);
        if (fk) {
          const column = fk[1]!.trim().toLowerCase();
          columns.push({
            table: currentTable,
            column,
            line: index + 1,
            isForeignKey: true,
            isIdentity: IDENTITY_COLUMNS.test(column),
            hasUnique: false,
            hasIndex: indexes.has(`${currentTable}.${column}`),
          });
        }
      }
      return;
    }
    const rest = columnMatch[2]!.toLowerCase();
    const isForeignKey = /references\s+\w+/i.test(rest) || /foreign/i.test(rest);
    const hasUnique = /unique/i.test(rest) || inlineUniqueTables.has(currentTable);
    columns.push({
      table: currentTable,
      column: name,
      line: index + 1,
      isForeignKey,
      isIdentity: IDENTITY_COLUMNS.test(name),
      hasUnique,
      hasIndex: indexes.has(`${currentTable}.${name}`),
    });
  });

  // Indexes declared after the table definition.
  for (const column of columns) {
    if (indexes.has(`${column.table}.${column.column}`)) column.hasIndex = true;
  }

  return { columns, indexes, drops };
}

function parseLaravelMigrations(path: string, content: string): { columns: TableColumn[]; drops: number[] } {
  const columns: TableColumn[] = [];
  const drops: number[] = [];
  const lines = content.split("\n");
  let table = "unknown";
  const tableMatch = content.match(/Schema::(?:create|table)\(\s*['"]([^'"]+)['"]/);
  if (tableMatch) table = tableMatch[1]!;

  lines.forEach((line, index) => {
    const foreign = line.match(/\$table->(?:foreignId|unsignedBigInteger|foreign)\(\s*['"]([^'"]+)['"]\s*\)([^;]*);/);
    if (foreign) {
      const column = foreign[1]!.toLowerCase();
      columns.push({
        table,
        column,
        line: index + 1,
        isForeignKey: true,
        isIdentity: IDENTITY_COLUMNS.test(column),
        hasUnique: /unique\s*\(/.test(foreign[2] ?? ""),
        hasIndex: /index\s*\(/.test(foreign[2] ?? ""),
      });
      return;
    }
    const plain = line.match(/\$table->(?:string|integer|uuid|bigInteger|text)\(\s*['"]([^'"]+)['"]\s*\)([^;]*);/);
    if (plain) {
      const column = plain[1]!.toLowerCase();
      columns.push({
        table,
        column,
        line: index + 1,
        isForeignKey: false,
        isIdentity: IDENTITY_COLUMNS.test(column),
        hasUnique: /unique\s*\(/.test(plain[2] ?? ""),
        hasIndex: /index\s*\(/.test(plain[2] ?? ""),
      });
    }
    if (/dropColumn|dropIfExists|drop\(/.test(line)) drops.push(index + 1);
  });

  return { columns, drops };
}

function parsePrisma(path: string, content: string): { columns: TableColumn[] } {
  const columns: TableColumn[] = [];
  const lines = content.split("\n");
  let model = "unknown";
  const modelIndexes = new Set<string>();
  lines.forEach((line, index) => {
    const modelMatch = line.match(/^model\s+([A-Za-z0-9_]+)\s*\{/);
    if (modelMatch) {
      model = modelMatch[1]!;
      modelIndexes.clear();
      return;
    }
    const indexMatch = line.match(/@@index\(\[([^\]]+)\]\)/);
    if (indexMatch) {
      for (const column of indexMatch[1]!.split(",")) modelIndexes.add(`${model}.${column.trim()}`);
      return;
    }
    const uniqueMatch = line.match(/@@unique\(\[([^\]]+)\]\)/);
    if (uniqueMatch) {
      for (const column of uniqueMatch[1]!.split(",")) modelIndexes.add(`${model}.${column.trim()}`);
      return;
    }
    const field = line.match(/^\s{2}([A-Za-z0-9_]+)\s+([A-Za-z0-9_\[\]?]+)/);
    if (!field) return;
    const name = field[1]!;
    const relation = /@relation/.test(line) || /Id$/.test(name);
    columns.push({
      table: model,
      column: name,
      line: index + 1,
      isForeignKey: relation,
      isIdentity: IDENTITY_COLUMNS.test(name),
      hasUnique: /@unique/.test(line) || modelIndexes.has(`${model}.${name}`),
      hasIndex: /@@?index/.test(line) || modelIndexes.has(`${model}.${name}`),
    });
  });
  return { columns };
}

function parseDjangoModels(path: string, content: string): { columns: TableColumn[] } {
  const columns: TableColumn[] = [];
  const lines = content.split("\n");
  let model = "unknown";
  lines.forEach((line, index) => {
    const cls = line.match(/^class\s+([A-Za-z0-9_]+)\s*\(/);
    if (cls) model = cls[1]!;
    const fk = line.match(/^\s{4}([a-z0-9_]+)\s*=\s*models\.(ForeignKey|OneToOneField|ManyToManyField)\(/);
    if (fk) {
      columns.push({
        table: model,
        column: fk[1]!,
        line: index + 1,
        isForeignKey: true,
        isIdentity: IDENTITY_COLUMNS.test(fk[1]!),
        hasUnique: /unique\s*=\s*True/.test(line),
        hasIndex: /db_index\s*=\s*True/.test(line),
      });
      return;
    }
    const field = line.match(/^\s{4}([a-z0-9_]+)\s*=\s*models\.(CharField|EmailField|SlugField|IntegerField|TextField)\(/);
    if (field) {
      columns.push({
        table: model,
        column: field[1]!,
        line: index + 1,
        isForeignKey: false,
        isIdentity: IDENTITY_COLUMNS.test(field[1]!),
        hasUnique: /unique\s*=\s*True/.test(line),
        hasIndex: /db_index\s*=\s*True/.test(line),
      });
    }
  });
  return { columns };
}

export function runDatabaseEngine(ctx: EngineContext): RawFinding[] {
  const findings: RawFinding[] = [];
  const seen = new Set<string>();
  const emit = (finding: RawFinding) => {
    const key = `${finding.ruleId}:${finding.filePath}:${finding.lineStart ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  const allIndexes = new Set<string>();
  const schemaResults: { path: string; columns: TableColumn[]; drops: number[] }[] = [];

  for (const file of ctx.files) {
    const content = file.content ?? "";
    if (!content) continue;
    const name = file.path.split("/").pop() ?? file.path;

    if (/\.sql$/i.test(name)) {
      const parsed = parseSqlSchema(file.path, content);
      for (const key of parsed.indexes) allIndexes.add(key);
      schemaResults.push({ path: file.path, columns: parsed.columns, drops: parsed.drops });
    } else if (/migrations?\//.test(file.path) && /\.php$/.test(name)) {
      const parsed = parseLaravelMigrations(file.path, content);
      schemaResults.push({ path: file.path, columns: parsed.columns, drops: parsed.drops });
    } else if (name === "schema.prisma" || /\.prisma$/.test(name)) {
      const parsed = parsePrisma(file.path, content);
      schemaResults.push({ path: file.path, columns: parsed.columns, drops: [] });
    } else if (/models?\.py$/.test(name)) {
      const parsed = parseDjangoModels(file.path, content);
      schemaResults.push({ path: file.path, columns: parsed.columns, drops: [] });
    }
  }

  for (const schema of schemaResults) {
    const content = ctx.files.find((file) => file.path === schema.path)?.content ?? "";
    for (const column of schema.columns) {
      if (column.isForeignKey && !column.hasIndex && !allIndexes.has(`${column.table}.${column.column}`)) {
        emit(
          makeFinding({
            ruleId: "DBN-001",
            path: schema.path,
            line: column.line,
            symbol: `${column.table}.${column.column}`,
            snippet: snippetAround(content, column.line, 1),
            confidence: 0.7,
            toolReference: `database-engine:fk-index:${schema.path}:${column.line}`,
            metadata: { table: column.table, column: column.column },
          }),
        );
      }
      if (column.isIdentity && !column.hasUnique) {
        emit(
          makeFinding({
            ruleId: "DBN-002",
            path: schema.path,
            line: column.line,
            symbol: `${column.table}.${column.column}`,
            snippet: snippetAround(content, column.line, 1),
            confidence: 0.6,
            toolReference: `database-engine:unique:${schema.path}:${column.line}`,
            metadata: { table: column.table, column: column.column },
          }),
        );
      }
    }
    for (const line of schema.drops.slice(0, 3)) {
      emit(
        makeFinding({
          ruleId: "DBN-005",
          path: schema.path,
          line,
          snippet: snippetAround(content, line, 1),
          confidence: 0.8,
          toolReference: `database-engine:destructive:${schema.path}:${line}`,
          metadata: { statement: (content.split("\n")[line - 1] ?? "").trim().slice(0, 160) },
        }),
      );
    }
  }

  // Raw queries in application code.
  for (const file of ctx.files) {
    const content = file.content ?? "";
    if (!content || isDocPath(file.path)) continue;

    for (const match of matchLines(content, /select\s+\*\s+from\s+[a-z0-9_.]+/gi, 5)) {
      emit(
        makeFinding({
          ruleId: "DBN-004",
          path: file.path,
          line: match.line,
          snippet: snippetAround(content, match.line, 1),
          confidence: 0.7,
          toolReference: `database-engine:select-star:${file.path}:${match.line}`,
        }),
      );
    }

    if (isTestPath(file.path)) continue;

    // N+1: a database call inside a loop body.
    if (/(query|execute|findOne|findUnique|findByPk|select\b|\.all\(\)|aggregate)/.test(content)) {
      const loopRegex = /(?:for\s*\(|for\s+\w+\s+in|\.map\s*\(|\.forEach\s*\(|while\s*\()/g;
      for (const loop of matchLines(content, loopRegex, 30)) {
        const window = content
          .split("\n")
          .slice(loop.line - 1, loop.line + 18)
          .join("\n");
        const dbCall = window.match(/(?:\bpool\.query|\bdb\.query|\.query\s*\(|\bprisma\.|findOne\s*\(|findUnique\s*\(|findByPk\s*\(|session\.query|Model\.find|\bselect\b)/);
        if (dbCall) {
          emit(
            makeFinding({
              ruleId: "DBN-003",
              path: file.path,
              line: loop.line,
              snippet: window.split("\n").slice(0, 14).join("\n"),
              confidence: 0.65,
              toolReference: `database-engine:n-plus-one:${file.path}:${loop.line}`,
              metadata: { detectedCall: dbCall[0].trim() },
            }),
          );
          break;
        }
      }
    }
  }

  return findings;
}
