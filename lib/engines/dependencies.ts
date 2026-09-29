import type { DependencyRecord, RawFinding, Severity, VulnerabilityRecord } from "../types";
import type { EngineContext } from "./shared";
import { query } from "../db";
import { isDocPath, makeFinding, snippetAround } from "./shared";

/**
 * Dependency engine (§18): manifests are parsed deterministically, and vulnerability
 * data comes from the OSV database — never from a language model. If OSV cannot be
 * reached the run records that explicitly instead of guessing.
 */

export interface DependencyScanResult {
  records: DependencyRecord[];
  findings: RawFinding[];
  notes: string[];
  verified: boolean;
  advisorySource: string;
}

const ECOSYSTEMS: Record<string, string> = {
  npm: "npm",
  composer: "Packagist",
  pip: "PyPI",
  pub: "Pub",
  go: "Go",
  cargo: "crates.io",
  rubygems: "RubyGems",
  maven: "Maven",
};

function cleanVersion(raw: string): string {
  return raw
    .trim()
    .replace(/^[\^~>=<=!* ]+/, "")
    .replace(/^v/, "")
    .split(/[\s,|]/)[0]!
    .replace(/['"]/g, "");
}

function isUnpinned(spec: string): boolean {
  const value = spec.trim();
  if (!value) return false;
  if (/^(?:\*|latest|x|>|>=|\^|~)/.test(value)) return true;
  if (/\|\||[><]=?\s*[\d.]+\s*$/.test(value) && !/^\d+\.\d+\.\d+$/.test(value)) return true;
  return false;
}

interface ParsedManifest {
  path: string;
  packageManager: keyof typeof ECOSYSTEMS | string;
  ecosystem: string;
  entries: { name: string; version: string; scope: "direct" | "transitive"; unpinned: boolean }[];
}

function parsePackageJson(path: string, content: string): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  try {
    const data = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
    for (const [section, scope] of [
      ["dependencies", "direct"],
      ["devDependencies", "direct"],
      ["peerDependencies", "direct"],
      ["optionalDependencies", "direct"],
    ] as const) {
      const block = data[section];
      if (!block) continue;
      for (const [name, spec] of Object.entries(block)) {
        entries.push({ name, version: cleanVersion(spec), scope, unpinned: isUnpinned(spec) });
      }
    }
  } catch {
    /* malformed manifest — the parser simply yields nothing */
  }
  return { path, packageManager: "npm", ecosystem: "npm", entries };
}

function parsePackageLock(path: string, content: string, limit = 260): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  try {
    const data = JSON.parse(content) as {
      packages?: Record<string, { version?: string; dev?: boolean }>;
      dependencies?: Record<string, { version?: string }>;
    };
    if (data.packages) {
      for (const [key, meta] of Object.entries(data.packages)) {
        if (!key || !meta?.version) continue;
        if (key.startsWith("node_modules/")) continue;
        const name = key.replace(/^.*node_modules\//, "");
        entries.push({ name, version: meta.version, scope: "transitive", unpinned: false });
        if (entries.length >= limit) break;
      }
    } else if (data.dependencies) {
      for (const [name, meta] of Object.entries(data.dependencies)) {
        if (!meta?.version) continue;
        entries.push({ name, version: meta.version, scope: "transitive", unpinned: false });
        if (entries.length >= limit) break;
      }
    }
  } catch {
    /* ignore */
  }
  return { path, packageManager: "npm", ecosystem: "npm", entries };
}

function parseRequirements(path: string, content: string): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const match = line.match(/^([A-Za-z0-9._\-\[\]]+)\s*(?:([<>=!~]{1,2})\s*([^\s;#]+))?/);
    if (!match) continue;
    const name = match[1]!.replace(/\[.*\]$/, "");
    const exact = match[2] === "==";
    entries.push({
      name,
      version: exact ? cleanVersion(match[3] ?? "") : "",
      scope: "direct",
      unpinned: !exact,
    });
  }
  return { path, packageManager: "pip", ecosystem: "PyPI", entries };
}

function parsePyproject(path: string, content: string): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  const depBlock = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (depBlock) {
    for (const item of depBlock[1]!.split(",")) {
      const match = item.match(/["']([A-Za-z0-9._\-]+)\s*([<>=!~^]*)\s*([^"']*)["']/);
      if (!match) continue;
      const exact = match[2]!.startsWith("==");
      entries.push({
        name: match[1]!,
        version: exact ? cleanVersion(match[3] ?? "") : "",
        scope: "direct",
        unpinned: !exact,
      });
    }
  }
  const poetry = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (poetry) {
    for (const line of poetry[1]!.split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9._\-]+)\s*=\s*["']?([^"'\n]*)["']?/);
      if (!match || match[1] === "python") continue;
      entries.push({
        name: match[1]!,
        version: cleanVersion(match[2] ?? ""),
        scope: "direct",
        unpinned: !/^\d/.test((match[2] ?? "").trim()),
      });
    }
  }
  return { path, packageManager: "pip", ecosystem: "PyPI", entries };
}

function parseComposer(path: string, content: string, lock: boolean): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  try {
    const data = JSON.parse(content) as {
      require?: Record<string, string>;
      "require-dev"?: Record<string, string>;
      packages?: { name: string; version: string }[];
      "packages-dev"?: { name: string; version: string }[];
    };
    if (lock && data.packages) {
      for (const item of [...data.packages, ...(data["packages-dev"] ?? [])]) {
        entries.push({ name: item.name, version: cleanVersion(item.version), scope: "transitive", unpinned: false });
      }
    } else {
      for (const [section, scope] of [["require", "direct"], ["require-dev", "direct"]] as const) {
        const block = data[section];
        if (!block) continue;
        for (const [name, spec] of Object.entries(block)) {
          if (name === "php" || name.startsWith("ext-")) continue;
          entries.push({ name, version: cleanVersion(spec), scope, unpinned: isUnpinned(spec) });
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { path, packageManager: "composer", ecosystem: "Packagist", entries };
}

function parsePubspec(path: string, content: string): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  const block = content.match(/dependencies:([\s\S]*?)(?=\n[a-z_]+:|$)/);
  if (block) {
    for (const line of block[1]!.split("\n")) {
      const match = line.match(/^\s{2}([a-z0-9_]+):\s*(.*)$/);
      if (!match || match[1] === "flutter" || match[1] === "sdk") continue;
      const spec = (match[2] ?? "").replace(/["']/g, "").trim();
      entries.push({ name: match[1]!, version: cleanVersion(spec), scope: "direct", unpinned: !spec.startsWith("^") && !/^\d/.test(spec) });
    }
  }
  return { path, packageManager: "pub", ecosystem: "Pub", entries };
}

function parseGoMod(path: string, content: string): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*([a-z0-9.\-]+\/[^\s]+)\s+v([^\s]+)(\s+\/\/\s+indirect)?/i);
    if (!match) continue;
    entries.push({
      name: match[1]!,
      version: match[2]!,
      scope: match[3] ? "transitive" : "direct",
      unpinned: false,
    });
  }
  return { path, packageManager: "go", ecosystem: "Go", entries };
}

function parseCargo(path: string, content: string, lock: boolean): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  if (lock) {
    const blocks = content.split("[[package]]").slice(1);
    for (const block of blocks) {
      const name = block.match(/name\s*=\s*"([^"]+)"/)?.[1];
      const version = block.match(/version\s*=\s*"([^"]+)"/)?.[1];
      if (name && version) entries.push({ name, version, scope: "transitive", unpinned: false });
    }
    return { path, packageManager: "cargo", ecosystem: "crates.io", entries };
  }
  const depSection = content.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (depSection) {
    for (const line of depSection[1]!.split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!match) continue;
      const spec = match[2]!.trim();
      const version = spec.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? spec.replace(/["']/g, "");
      entries.push({ name: match[1]!, version: cleanVersion(version), scope: "direct", unpinned: isUnpinned(version) });
    }
  }
  return { path, packageManager: "cargo", ecosystem: "crates.io", entries };
}

function parseGemfileLock(path: string, content: string): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  let inGemSection = false;
  for (const line of content.split("\n")) {
    if (/^\s*GEM/.test(line) || /^\s*specs:/.test(line)) {
      inGemSection = true;
      continue;
    }
    if (/^\s*[A-Z]{2,}/.test(line)) inGemSection = false;
    if (!inGemSection) continue;
    const match = line.match(/^\s{4}([A-Za-z0-9._\-]+)\s*\(([^)]+)\)/);
    if (match) entries.push({ name: match[1]!, version: match[2]!, scope: "transitive", unpinned: false });
  }
  return { path, packageManager: "rubygems", ecosystem: "RubyGems", entries };
}

function parsePomXml(path: string, content: string): ParsedManifest {
  const entries: ParsedManifest["entries"] = [];
  const deps = content.match(/<dependencies>([\s\S]*?)<\/dependencies>/g) ?? [];
  for (const block of deps) {
    const items = block.split("<dependency>").slice(1);
    for (const item of items) {
      const group = item.match(/<groupId>([^<]+)</)?.[1];
      const artifact = item.match(/<artifactId>([^<]+)</)?.[1];
      const version = item.match(/<version>([^<]+)</)?.[1] ?? "";
      if (group && artifact) {
        entries.push({
          name: `${group}:${artifact}`,
          version: cleanVersion(version),
          scope: "direct",
          unpinned: !version || version.includes("$"),
        });
      }
    }
  }
  return { path, packageManager: "maven", ecosystem: "Maven", entries };
}

export function parseManifests(files: { path: string; content: string }[]): ParsedManifest[] {
  const manifests: ParsedManifest[] = [];
  for (const file of files) {
    const name = file.path.split("/").pop() ?? file.path;
    switch (name) {
      case "package.json":
        manifests.push(parsePackageJson(file.path, file.content));
        break;
      case "package-lock.json":
        manifests.push(parsePackageLock(file.path, file.content));
        break;
      case "requirements.txt":
        manifests.push(parseRequirements(file.path, file.content));
        break;
      case "pyproject.toml":
        manifests.push(parsePyproject(file.path, file.content));
        break;
      case "composer.json":
        manifests.push(parseComposer(file.path, file.content, false));
        break;
      case "composer.lock":
        manifests.push(parseComposer(file.path, file.content, true));
        break;
      case "pubspec.yaml":
        manifests.push(parsePubspec(file.path, file.content));
        break;
      case "go.mod":
        manifests.push(parseGoMod(file.path, file.content));
        break;
      case "Cargo.toml":
        manifests.push(parseCargo(file.path, file.content, false));
        break;
      case "Cargo.lock":
        manifests.push(parseCargo(file.path, file.content, true));
        break;
      case "Gemfile.lock":
        manifests.push(parseGemfileLock(file.path, file.content));
        break;
      case "pom.xml":
        manifests.push(parsePomXml(file.path, file.content));
        break;
      default:
        break;
    }
  }
  return manifests;
}

/* --------------------------------- OSV -------------------------------- */

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  severity?: { type?: string; score?: string }[];
  affected?: {
    ranges?: { events?: { fixed?: string; introduced?: string }[] }[];
    versions?: string[];
  }[];
  references?: { type?: string; url: string }[];
  database_specific?: { severity?: string; cvss?: { score?: number } };
}

function severityFromVuln(vuln: OsvVuln): { severity: Severity; cvss: number | null } {
  const direct = vuln.database_specific?.severity?.toUpperCase();
  if (direct && ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(direct)) {
    return { severity: direct as Severity, cvss: vuln.database_specific?.cvss?.score ?? null };
  }

  let cvss: number | null = null;
  const numericDirect = vuln.database_specific?.cvss?.score;
  if (typeof numericDirect === "number") cvss = numericDirect;
  if (cvss === null) {
    for (const entry of vuln.severity ?? []) {
      const score = (entry.score ?? "").trim();
      if (/^\d+(?:\.\d+)?$/.test(score)) {
        cvss = Number(score);
        break;
      }
    }
  }
  if (cvss !== null) {
    if (cvss >= 9) return { severity: "CRITICAL", cvss };
    if (cvss >= 7) return { severity: "HIGH", cvss };
    if (cvss >= 4) return { severity: "MEDIUM", cvss };
    return { severity: "LOW", cvss };
  }

  // No numeric score: read the CVSS vector's impact metrics (C/I/A) instead of guessing.
  const vector = (vuln.severity ?? []).map((entry) => entry.score ?? "").find((score) => score.includes("CVSS:"));
  if (vector) {
    const strictness = ["VC", "VI", "VA"].map((metric) => new RegExp(`${metric}:([HLN])`).exec(vector)?.[1] ?? "N");
    const high = strictness.filter((value) => value === "H").length;
    const low = strictness.filter((value) => value === "L").length;
    if (high === 3) return { severity: "CRITICAL", cvss: null };
    if (high >= 1) return { severity: "HIGH", cvss: null };
    if (low >= 1) return { severity: "MEDIUM", cvss: null };
    return { severity: "LOW", cvss: null };
  }

  return { severity: "MEDIUM", cvss: null };
}

function fixedVersionFrom(vuln: OsvVuln): string | null {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return null;
}

async function queryOsv(
  queries: { name: string; version: string; ecosystem: string }[],
): Promise<Map<string, OsvVuln[]>> {
  const results = new Map<string, OsvVuln[]>();
  const chunks: typeof queries[] = [];
  for (let index = 0; index < queries.length; index += 100) chunks.push(queries.slice(index, index + 100));

  for (const chunk of chunks) {
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "CodeAudit/1.0" },
      body: JSON.stringify({
        queries: chunk.map((item) => ({
          package: { ecosystem: item.ecosystem, name: item.name },
          version: item.version,
        })),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`osv ${response.status}`);
    const data = (await response.json()) as { results?: { vulns?: OsvVuln[] }[] };
    (data.results ?? []).forEach((result, index) => {
      const item = chunk[index];
      if (!item) return;
      const key = `${item.ecosystem}:${item.name}@${item.version}`;
      results.set(key, result.vulns ?? []);
    });
  }
  return results;
}

async function fetchVulnDetail(id: string): Promise<OsvVuln | null> {
  const cacheKey = `osv:${id}`;
  try {
    const cached = await query<{ payload: OsvVuln }>(
      `select payload from registry_cache where key = $1 and fetched_at > now() - interval '7 days' limit 1`,
      [cacheKey],
    );
    if (cached[0]?.payload) return cached[0].payload;
  } catch {
    /* cache is an optimisation, not a requirement */
  }
  try {
    const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(12_000),
      headers: { "user-agent": "CodeAudit/1.0" },
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as OsvVuln;
    await query(
      `insert into registry_cache (key, payload, fetched_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set payload = excluded.payload, fetched_at = now()`,
      [cacheKey, JSON.stringify(detail)],
    ).catch(() => undefined);
    return detail;
  } catch {
    return null;
  }
}

async function hydrateVulns(ids: string[]): Promise<Map<string, OsvVuln>> {
  const map = new Map<string, OsvVuln>();
  const unique = Array.from(new Set(ids)).slice(0, 30);
  for (const id of unique) {
    const detail = await fetchVulnDetail(id);
    if (detail) map.set(id, detail);
  }
  return map;
}

async function latestVersion(ecosystem: string, name: string, timeoutMs = 5_000): Promise<string | null> {
  try {
    const url =
      ecosystem === "npm"
        ? `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`
        : ecosystem === "PyPI"
          ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
          : null;
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "CodeAudit/1.0" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string; info?: { version?: string } };
    return data.version ?? data.info?.version ?? null;
  } catch {
    return null;
  }
}

function majorOf(version: string): number | null {
  const match = version.match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

interface EntryRecord {
  name: string;
  version: string;
  scope: "direct" | "transitive";
  manifest: string;
  unpinned: boolean;
  ecosystem: string;
  manager: string;
}

export async function runDependenciesEngine(ctx: EngineContext): Promise<DependencyScanResult> {
  const notes: string[] = [];
  const findings: RawFinding[] = [];
  const records: DependencyRecord[] = [];

  const textFiles = ctx.files.filter((file) => file.text && file.content && !isDocPath(file.path));
  const manifests = parseManifests(
    textFiles.map((file) => ({ path: file.path, content: file.content ?? "" })),
  );

  // Prefer lock files for exact versions, manifests for direct/declared scope.
  const directByName = new Map<string, EntryRecord>();
  const allEntries: EntryRecord[] = [];

  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      const key = `${manifest.ecosystem}:${entry.name}`;
      const record = {
        name: entry.name,
        version: entry.version,
        scope: entry.scope,
        manifest: manifest.path,
        unpinned: entry.unpinned,
        ecosystem: manifest.ecosystem,
        manager: manifest.packageManager,
      };
      allEntries.push(record);
      const existing = directByName.get(key);
      if (!existing || (existing.scope === "transitive" && entry.scope === "direct")) {
        directByName.set(key, record);
      }
    }
  }

  const deduped = new Map<string, (typeof allEntries)[number]>();
  for (const entry of allEntries) {
    if (!entry.version) continue;
    const key = `${entry.ecosystem}:${entry.name}@${entry.version}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  }

  const queries = Array.from(deduped.values()).slice(0, 400);
  let verified = false;
  const vulnMap = new Map<string, OsvVuln[]>();

  if (queries.length === 0) {
    notes.push("No dependency manifest was found, so the dependency engine had nothing to check.");
  } else {
    try {
      const result = await queryOsv(
        queries.map((item) => ({ name: item.name, version: item.version, ecosystem: item.ecosystem })),
      );
      for (const [key, vulns] of result) vulnMap.set(key, vulns);
      const details = await hydrateVulns(Array.from(vulnMap.values()).flat().map((vuln) => vuln.id));
      for (const [key, vulns] of vulnMap) {
        vulnMap.set(
          key,
          vulns.map((vuln) => details.get(vuln.id) ?? vuln),
        );
      }
      verified = true;
      notes.push(`Checked ${queries.length} dependency versions against the OSV advisory database.`);
    } catch (error) {
      notes.push(
        `The advisory database could not be reached (${error instanceof Error ? error.message : "network error"}), so vulnerabilities were NOT verified.`,
      );
      findings.push(
        makeFinding({
          ruleId: "DEP-004",
          path: manifests[0]?.path ?? textFiles[0]?.path ?? "unknown",
          snippet: "advisory source unreachable during this run",
          confidence: 1,
          toolReference: "dependencies-engine:osv-unreachable",
          metadata: { queriedPackages: queries.length },
        }),
      );
    }
  }

  // Latest-version check for a bounded set of direct dependencies (npm/PyPI only).
  const outdatedCandidates = Array.from(directByName.values()).filter(
    (entry) => entry.scope === "direct" && entry.version && (entry.ecosystem === "npm" || entry.ecosystem === "PyPI"),
  );
  const outdated = new Map<string, string>();
  if (Date.now() < ctx.deadline) {
    for (const entry of outdatedCandidates.slice(0, 20)) {
      if (Date.now() > ctx.deadline) break;
      const latest = await latestVersion(entry.ecosystem, entry.name);
      if (!latest || latest === entry.version) continue;
      const currentMajor = majorOf(entry.version);
      const latestMajor = majorOf(latest);
      if (currentMajor !== null && latestMajor !== null && latestMajor - currentMajor >= 1) {
        outdated.set(`${entry.ecosystem}:${entry.name}@${entry.version}`, latest);
      }
    }
  }

  for (const [key, entry] of deduped) {
    const vulns = vulnMap.get(key) ?? [];
    const vulnRecords: VulnerabilityRecord[] = vulns.map((vuln) => {
      const { severity, cvss } = severityFromVuln(vuln);
      return {
        advisoryId: vuln.id,
        severity,
        cvss,
        summary: vuln.summary ?? vuln.aliases?.[0] ?? vuln.id,
        description: (vuln.details ?? vuln.summary ?? "").slice(0, 1200),
        fixedVersion: fixedVersionFrom(vuln),
        source: "OSV",
        publishedAt: vuln.published ?? null,
        references: (vuln.references ?? []).slice(0, 5).map((ref) => ref.url),
      };
    });
    records.push({
      packageManager: entry.manager,
      packageName: entry.name,
      version: entry.version,
      ecosystem: entry.ecosystem,
      scope: entry.scope,
      manifestPath: entry.manifest,
      latestVersion: outdated.get(key) ?? null,
      outdated: outdated.has(key),
      vulnerabilities: vulnRecords,
    });
  }

  // One finding per vulnerable package (severity from the advisory itself).
  for (const record of records) {
    const vulnerable = record.vulnerabilities ?? [];
    if (vulnerable.length === 0) continue;
    const worst = [...vulnerable].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0]!;
    const file = textFiles.find((candidate) => candidate.path === record.manifestPath);
    const manifestContent = file?.content ?? "";
    const line = Math.max(1, manifestContent.split("\n").findIndex((row) => row.includes(record.packageName)) + 1);
    findings.push(
      makeFinding({
        ruleId: "DEP-001",
        path: record.manifestPath,
        line: line || 1,
        snippet: `"${record.packageName}": "${record.version}"  // ${vulnerable.map((v) => v.advisoryId).join(", ")}`,
        confidence: 0.95,
        severityOverride: worst.severity,
        severityReason: `Advisory ${worst.advisoryId} rates this ${worst.severity}${worst.cvss ? ` (CVSS ${worst.cvss})` : ""}.`,
        toolReference: `osv:${record.packageName}@${record.version}`,
        metadata: {
          package: record.packageName,
          version: record.version,
          ecosystem: record.ecosystem,
          packageManager: record.packageManager,
          scope: record.scope,
          advisories: vulnerable.map((v) => ({
            id: v.advisoryId,
            severity: v.severity,
            fixedVersion: v.fixedVersion,
            url: v.references[0] ?? null,
            summary: v.summary,
          })),
        },
        extraEvidence: vulnerable.slice(0, 3).map((vuln) => ({
          sourceType: "external_advisory" as const,
          sourceReference: vuln.advisoryId,
          snippet: vuln.summary.slice(0, 400),
          metadata: { severity: vuln.severity, fixedVersion: vuln.fixedVersion, references: vuln.references },
        })),
      }),
    );
  }

  // Unpinned ranges, aggregated per manifest so the list stays readable.
  const byManifest = new Map<string, string[]>();
  for (const entry of allEntries) {
    if (!entry.unpinned) continue;
    const list = byManifest.get(entry.manifest) ?? [];
    if (list.length < 12) list.push(`${entry.name}: ${entry.version || "unpinned"}`);
    byManifest.set(entry.manifest, list);
  }
  for (const [path, examples] of byManifest) {
    const file = textFiles.find((candidate) => candidate.path === path);
    findings.push(
      makeFinding({
        ruleId: "DEP-002",
        path,
        line: 1,
        snippet: examples.slice(0, 5).join("\n"),
        confidence: 0.85,
        toolReference: `dependencies-engine:${path}:unpinned`,
        metadata: { examples },
        extraEvidence: file
          ? [
              {
                sourceType: "manifest" as const,
                sourceReference: `${path} (first 12 lines)`,
                snippet: (file.content ?? "").split("\n").slice(0, 12).join("\n"),
              },
            ]
          : [],
      }),
    );
  }

  // Outdated direct dependencies.
  const outdatedByManifest = new Map<string, string[]>();
  for (const [key, latest] of outdated) {
    const entry = deduped.get(key) ?? Array.from(deduped.values()).find((item) => `${item.ecosystem}:${item.name}@${item.version}` === key);
    if (!entry) continue;
    const list = outdatedByManifest.get(entry.manifest) ?? [];
    list.push(`${entry.name}: ${entry.version} → ${latest}`);
    outdatedByManifest.set(entry.manifest, list);
  }
  for (const [path, examples] of outdatedByManifest) {
    findings.push(
      makeFinding({
        ruleId: "DEP-003",
        path,
        line: 1,
        snippet: examples.slice(0, 5).join("\n"),
        confidence: 0.75,
        toolReference: `registry:${path}:outdated`,
        metadata: { examples },
      }),
    );
  }

  return {
    records,
    findings,
    notes,
    verified,
    advisorySource: "OSV (api.osv.dev)",
  };
}

function severityRank(severity: Severity): number {
  return ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(severity);
}
