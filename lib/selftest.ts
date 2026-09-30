import { deflateRawSync } from "node:zlib";
import { demoSnapshot } from "./demo/demo-repo";
import { extractArchive } from "./sources/extract";
import { buildSnapshot, countLoc, snapshotFromRawFiles } from "./sources/snapshot";
import { detectStack } from "./engines/stack";
import { runSecretsEngine } from "./engines/secrets";
import { runSecurityEngine } from "./engines/security";
import { runApiEngine } from "./engines/api";
import { runTestsEngine } from "./engines/tests";
import { selectRunnableTestFiles } from "./sandbox/candidates";
import { parseTap } from "./sandbox/tap";
import { GUARD_SOURCE } from "./sandbox/guard";
import { runArchitectureEngine } from "./engines/architecture";
import { runDatabaseEngine } from "./engines/database";
import { runOpsEngine } from "./engines/ops";
import { maskValue, type EngineContext } from "./engines/shared";
import { normaliseFindings, fingerprintFor } from "./analysis/evidence";
import { findingEvidenceRefs } from "./ai/evidence-links";
import { parseManifests } from "./engines/dependencies";
import { RULE_CATALOG } from "./rules/catalog";
import { FINDING_EXPLANATION_PROMPT, REPORT_SUMMARY_PROMPT } from "./ai/prompts";
import type { RepoSnapshot } from "./types";

function makeContextForTests(snapshot: RepoSnapshot): EngineContext {
  const notes: string[] = [];
  return {
    snapshot,
    files: snapshot.files.filter((file) => file.text && typeof file.content === "string"),
    emit: () => undefined,
    note: (message: string) => notes.push(message),
    deadline: Date.now() + 60_000,
  };
}

export interface SelfTestResult {
  name: string;
  description: string;
  passed: boolean;
  detail: string;
}

function check(name: string, description: string, assertion: () => string | true): SelfTestResult {
  try {
    const result = assertion();
    if (result === true) return { name, description, passed: true, detail: "ok" };
    return { name, description, passed: true, detail: result };
  } catch (error) {
    return {
      name,
      description,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** Minimal ZIP writer (stored + deflate entries) so the upload path is covered by a test. */
function buildZip(files: { path: string; content: string }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.path, "utf8");
    const raw = Buffer.from(file.content, "utf8");
    const compressed = deflateRawSync(raw);
    const useDeflate = compressed.length < raw.length;
    const data = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = 0; // the reader does not verify CRC

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

export function runSelfTests(): SelfTestResult[] {
  const snapshot = demoSnapshot();
  const results: SelfTestResult[] = [];

  results.push(
    check("stack-detection", "Stack detection finds languages, framework and package manager", () => {
      const stack = detectStack(snapshot.files);
      assert(stack.languages.some((lang) => lang.name === "javascript"), "javascript was not detected");
      assert(stack.languages.some((lang) => lang.name === "python"), "python was not detected");
      assert(stack.frameworks.includes("Express"), "Express was not detected from the manifest");
      assert(stack.packageManagers.includes("npm"), "npm was not detected");
      assert(stack.testFrameworks.includes("Jest"), "Jest was not detected");
      return `${stack.languages.slice(0, 3).map((lang) => lang.name).join(", ")} · ${stack.frameworks.join(", ")}`;
    }),
  );

  results.push(
    check("framework-not-from-folder-name", "A framework is never inferred from a folder name", () => {
      const fake = buildSnapshot(
        [
          { path: "laravel/app/Http/Controllers/UserController.php", size: 40, text: "<?php\nclass UserController {}\n", binary: false },
        ],
        { type: "demo", label: "folder-name probe" },
        { binarySkipped: 0, ignoredPaths: 0, oversizedSkipped: 0, truncated: false },
      );
      assert(!fake.stack.frameworks.includes("Laravel"), "Laravel was inferred from the folder name alone");
      return "no framework claimed without a manifest signal";
    }),
  );

  results.push(
    check("secrets-masked", "Detected secrets never appear in clear text in findings", () => {
      const ctx = makeContextForTests(snapshot);
      const findings = runSecretsEngine(ctx);
      assert(findings.length > 0, "no secret finding was produced for the fixture");
      const leaked = findings.filter((finding) => (finding.snippet ?? "").includes("sk_live_EXAMPLEDEMO"));
      assert(leaked.length === 0, `raw secret leaked in ${leaked.length} finding(s)`);
      const full = findings.some((finding) => (finding.snippet ?? "").includes("SuperSecret123"));
      assert(!full, "a raw password leaked into a finding snippet");
      return `${findings.length} secret findings, all masked`;
    }),
  );

  results.push(
    check("fingerprint-stable", "Fingerprints are stable across line shifts and change with the code", () => {
      const a = fingerprintFor({ ruleId: "SEC-001", filePath: "src/config.js", anchorText: "  const apiKey = 'x'" });
      const b = fingerprintFor({ ruleId: "SEC-001", filePath: "src/config.js", anchorText: "const apiKey = 'x'" });
      const c = fingerprintFor({ ruleId: "SEC-001", filePath: "src/config.js", anchorText: "const apiKey = 'y'" });
      assert(a === b, "whitespace changed the fingerprint");
      assert(a !== c, "a changed line kept the same fingerprint");
      return a;
    }),
  );

  results.push(
    check("dedupe", "Duplicate findings collapse to one fingerprint with occurrence evidence", () => {
      const raw = [
        { ruleId: "SEC-101", filePath: "src/legacy.js", lineStart: 54, snippet: "eval(code)" },
        { ruleId: "SEC-101", filePath: "src/legacy.js", lineStart: 54, snippet: "eval(code)" },
      ];
      const normalised = normaliseFindings(raw, {
        runId: "run_test",
        projectId: "prj_test",
        snapshot,
        fileByPath: new Map(snapshot.files.map((file) => [file.path, file])),
      });
      assert(normalised.findings.length === 1, `expected 1 finding, got ${normalised.findings.length}`);
      assert(Number(normalised.findings[0]!.metadata.occurrences) === 2, "occurrences were not merged");
      return "1 finding, occurrences=2";
    }),
  );

  results.push(
    check("evidence-grounding", "Findings pointing outside the manifest are rejected", () => {
      const raw = [{ ruleId: "SEC-101", filePath: "src/does-not-exist.js", lineStart: 1, snippet: "eval(x)" }];
      const normalised = normaliseFindings(raw, {
        runId: "run_test",
        projectId: "prj_test",
        snapshot,
        fileByPath: new Map(snapshot.files.map((file) => [file.path, file])),
      });
      assert(normalised.findings.length === 0, "a finding for a non-existent file was accepted");
      assert(normalised.rejectedReferences.length === 1, "the rejected reference was not recorded");
      return "rejected and recorded";
    }),
  );

  results.push(
    check("ai-reference-verification", "AI references to missing files or impossible lines are rejected", () => {
      const fileContents = new Map([["src/config.js", "line1\nline2\nline3"]]);
      const { accepted, rejected } = findingEvidenceRefs(
        [
          { file: "src/config.js", line: 2 },
          { file: "src/ghost.js", line: 1 },
          { file: "src/config.js", line: 999 },
        ],
        snapshot,
        fileContents,
      );
      assert(accepted.length === 1, `expected 1 accepted reference, got ${accepted.length}`);
      assert(rejected.length === 2, `expected 2 rejected references, got ${rejected.length}`);
      return "1 accepted, 2 rejected";
    }),
  );

  results.push(
    check("sql-injection-detection", "SQL string building is detected with a line reference", () => {
      const findings = runSecurityEngine(makeContextForTests(snapshot));
      const sql = findings.filter((finding) => finding.ruleId === "SEC-103");
      assert(sql.length > 0, "SEC-103 did not fire on the fixture");
      assert(sql[0]!.lineStart !== undefined, "the finding has no line number");
      return `SEC-103 at src/db.js:${sql[0]!.lineStart}`;
    }),
  );

  results.push(
    check("api-authorisation-detection", "A mutating route without an authorisation check is flagged", () => {
      const findings = runApiEngine(makeContextForTests(snapshot));
      const auth = findings.filter((finding) => finding.ruleId === "API-001");
      assert(auth.length > 0, "API-001 did not fire on the fixture");
      return `API-001 ×${auth.length}`;
    }),
  );

  results.push(
    check("test-artifact-parsing", "Failing committed tests and coverage are read from their artifacts", () => {
      const result = runTestsEngine(makeContextForTests(snapshot));
      const failing = result.findings.find((finding) => finding.ruleId === "TST-002");
      const coverage = result.findings.find((finding) => finding.ruleId === "TST-003");
      assert(failing, "TST-002 did not fire on the committed JUnit report");
      assert(coverage, "TST-003 did not fire on the committed coverage report");
      assert(result.testRuns.every((run) => run.executed === false), "a test run claimed execution");
      return "failing tests + 41% coverage, executed=false";
    }),
  );

  results.push(
    check("architecture-cycles", "Circular dependencies are detected from the import graph", () => {
      const result = runArchitectureEngine(makeContextForTests(snapshot));
      assert(result.summary.cycles.length > 0, "no cycle was detected in the fixture");
      return result.summary.cycles[0]!.path.join(" → ");
    }),
  );

  results.push(
    check("database-index-check", "Foreign keys without an index are reported", () => {
      const findings = runDatabaseEngine(makeContextForTests(snapshot));
      assert(
        findings.some((finding) => finding.ruleId === "DBN-001"),
        "DBN-001 did not fire on migrations/001_init.sql",
      );
      return "DBN-001 detected";
    }),
  );

  results.push(
    check("docker-root-check", "A container that runs as root is reported", () => {
      const findings = runOpsEngine(makeContextForTests(snapshot));
      assert(findings.some((finding) => finding.ruleId === "OPS-001"), "OPS-001 did not fire");
      assert(findings.some((finding) => finding.ruleId === "OPS-003"), "OPS-003 (remote script) did not fire");
      return "OPS-001 + OPS-003 detected";
    }),
  );

  results.push(
    check("dependency-parsing", "Manifests are parsed with versions and unpinned ranges", () => {
      const manifests = parseManifests(
        snapshot.files
          .filter((file) => file.content)
          .map((file) => ({ path: file.path, content: file.content ?? "" })),
      );
      const pkg = manifests.find((manifest) => manifest.path === "package.json");
      assert(pkg, "package.json was not parsed");
      const lodash = pkg!.entries.find((entry) => entry.name === "lodash");
      assert(lodash?.version === "4.17.11", `expected lodash 4.17.11, got ${lodash?.version ?? "nothing"}`);
      const pg = pkg!.entries.find((entry) => entry.name === "pg");
      assert(pg?.unpinned === true, '"pg": "latest" was not recognised as unpinned');
      return `${pkg!.entries.length} declared dependencies parsed`;
    }),
  );

  results.push(
    check("archive-extraction", "A ZIP upload is read safely, with path traversal rejected", () => {
      const zip = buildZip([
        { path: "src/index.js", content: "console.log('hi');\n" },
        { path: "node_modules/pkg/index.js", content: "should be ignored" },
        { path: "../escaped.txt", content: "should be rejected" },
      ]);
      const extracted = extractArchive(zip, "project.zip");
      const paths = extracted.entries.map((entry) => entry.path);
      assert(paths.includes("src/index.js"), "a normal file was not extracted");
      assert(!paths.some((path) => path.includes("node_modules")), "node_modules was not ignored");
      assert(!paths.some((path) => path.includes("..")), "a traversal path was accepted");
      return paths.join(", ");
    }),
  );

  results.push(
    check("loc-counting", "Logical line counting ignores blanks and comments", () => {
      const stats = countLoc("// comment\n\nconst a = 1;\n/* block\n   still block */\nconst b = 2;\n", "javascript");
      assert(stats.loc === 2, `expected 2 logical lines, got ${stats.loc}`);
      return `loc=${stats.loc} lines=${stats.lines}`;
    }),
  );

  results.push(
    check("masking", "Masking keeps a short prefix/suffix and hides the rest", () => {
      const masked = maskValue("sk_live_ABCDEFGHIJKLMNOP1234", 4);
      assert(masked.includes("****"), "no masking characters produced");
      assert(!masked.includes("ABCDEFGHIJKLMNOP"), "the secret body was not hidden");
      return masked;
    }),
  );

  results.push(
    check("rule-catalog-integrity", "Rule catalogue is versioned, unique and bilingual", () => {
      const ids = new Set<string>();
      for (const rule of RULE_CATALOG) {
        assert(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
        ids.add(rule.id);
        assert(rule.name.ar && rule.name.en, `${rule.id} is missing a translated name`);
        assert(rule.description.ar && rule.description.en, `${rule.id} is missing a translated description`);
        assert(rule.version.length > 0, `${rule.id} has no version`);
      }
      return `${RULE_CATALOG.length} rules, all translated and versioned`;
    }),
  );

  results.push(
    check("prompt-schema", "Prompts declare an id, a version and an output contract", () => {
      for (const prompt of [FINDING_EXPLANATION_PROMPT, REPORT_SUMMARY_PROMPT]) {
        assert(prompt.id.length > 0, "prompt without id");
        assert(prompt.version.length > 0, `${prompt.id} without version`);
        assert(prompt.outputContract.includes("{"), `${prompt.id} has no JSON contract`);
        assert(prompt.system.length > 40, `${prompt.id} system prompt is too short`);
      }
      return `${FINDING_EXPLANATION_PROMPT.id}@${FINDING_EXPLANATION_PROMPT.version}, ${REPORT_SUMMARY_PROMPT.id}@${REPORT_SUMMARY_PROMPT.version}`;
    }),
  );


  results.push(
    check("sandbox-candidates", "Only self-contained node:test files are ever executed", () => {
      const snapshot = snapshotFromRawFiles(
        [
          { path: "tests/self-contained.test.js", content: 'import test from "node:test";\ntest("t", () => {});' },
          { path: "tests/needs-jest.test.js", content: 'describe("x", () => { it("y", () => {}); });' },
          {
            path: "tests/needs-a-package.test.js",
            content: 'import test from "node:test";\nimport { z } from "zod";\ntest("t", () => z);',
          },
        ],
        { type: "upload", label: "self-test" },
      );
      const selection = selectRunnableTestFiles(snapshot, { maxFiles: 5 });
      assert(selection.runnable.length === 1, `expected one runnable file, got ${selection.runnable.length}`);
      assert(
        selection.runnable[0]!.path === "tests/self-contained.test.js",
        "the wrong file was selected for execution",
      );
      const reasons = selection.skipped.map((entry) => entry.reason).sort();
      assert(reasons.includes("needs-runner"), "a suite needing its own runner was not rejected");
      assert(reasons.includes("needs-dependencies"), "a suite needing a package was not rejected");
      return `1 runnable, ${selection.skipped.length} rejected with reasons`;
    }),
  );

  results.push(
    check("sandbox-tap", "Executed results are read from the runner's own output, with the failing line", () => {
      const tap = [
        "TAP version 13",
        "# Subtest: calc",
        "  # Subtest: adds",
        "  ok 1 - adds",
        "    ---",
        "    duration_ms: 0.4",
        "    ...",
        "  # Subtest: subtracts",
        "  not ok 2 - subtracts",
        "    ---",
        "    duration_ms: 0.6",
        "    location: '/tmp/ws/tests/calc.test.js:3:1'",
        "    failureType: 'testCodeFailure'",
        "    error: |-",
        "      Expected values to be strictly equal:",
        "    stack: |-",
        "      TestContext.<anonymous> (file:///tmp/ws/tests/calc.test.js:5:22)",
        "    ...",
        "not ok 1 - calc",
        "  ---",
        "  failureType: 'subtestFailed'",
        "  ...",
        "1..2",
        "# tests 2",
        "# pass 1",
        "# fail 1",
      ].join("\n");
      const parsed = parseTap(tap, "/tmp/ws");
      const totals = parsed.totals;
      assert(totals !== null && totals.tests === 2, "the harness summary was not read");
      assert(parsed.cases.length === 2, `expected 2 leaf cases, got ${parsed.cases.length}`);
      const failure = parsed.cases.find((item) => !item.ok);
      assert(failure?.file === "tests/calc.test.js", "the failing file was not mapped to the repository");
      assert(failure?.line === 5, `the assertion line was not used (got ${failure?.line})`);
      assert(!parsed.cases.some((item) => item.name === "calc"), "the suite line was counted as a case");
      return `${totals?.tests ?? 0} tests, failing case at ${failure?.file}:${failure?.line}`;
    }),
  );

  results.push(
    check("sandbox-guard", "The execution guard denies network, processes and DNS", () => {
      for (const needle of ["globalThis.fetch", "net.Socket.prototype.connect", "dgram.Socket.prototype.", "child_process", '"dns"']) {
        assert(GUARD_SOURCE.includes(needle), `the guard does not cover ${needle}`);
      }
      assert(GUARD_SOURCE.includes("__CODEAUDIT_SANDBOX__"), "the guard does not mark itself");
      return "network, sockets, processes and DNS entry points are denied";
    }),
  );

  return results;
}
