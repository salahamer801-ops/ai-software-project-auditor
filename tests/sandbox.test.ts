/**
 * The execution sandbox (§24, §56) — the only part of the system that runs code from the audited
 * project, so it carries the strongest guarantees and they are all asserted here, not described:
 *
 *  - what may run: only self-contained `node:test` files, walked through their relative imports;
 *  - what the child cannot do: write to disk, spawn processes, reach the network, see the host's
 *    environment;
 *  - what is reported: real counts from the runner's TAP summary, the assertion's own file and
 *    line, masked messages, and the limits the run executed under.
 *
 * The integration cases start real child processes; they are the slowest tests in the suite and
 * the reason the rest of the suite is allowed to be slow.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { RULE_CATALOG } from "../lib/rules/catalog";
import { selectRunnableTestFiles } from "../lib/sandbox/candidates";
import { GUARD_SOURCE } from "../lib/sandbox/guard";
import { runSandbox, safeJoin } from "../lib/sandbox/run";
import { parseTap, toRepoPath } from "../lib/sandbox/tap";
import { runExecutionEngine } from "../lib/engines/execution";
import type { RepoSnapshot } from "../lib/types";
import { snapshotOf } from "./helpers";

/* ------------------------------------------------------------------ candidates */

const NODE_TEST_FILE = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "../src/add";',
  'test("adds", () => { assert.equal(add(1, 1), 2); });',
].join("\n");

function runnableSnapshot(files: { path: string; content: string }[]): RepoSnapshot {
  return snapshotOf(files);
}

describe("candidate selection", () => {
  test("a self-contained node:test file with relative imports is runnable", () => {
    const selection = selectRunnableTestFiles(
      runnableSnapshot([
        { path: "tests/add.test.js", content: NODE_TEST_FILE },
        { path: "src/add.js", content: "export const add = (a, b) => a + b;" },
      ]),
    );
    assert.deepEqual(
      selection.runnable.map((file) => file.path),
      ["tests/add.test.js"],
    );
    assert.equal(selection.skipped.length, 0);
  });

  test("a suite that needs an installed runner is skipped, not failed", () => {
    const selection = selectRunnableTestFiles(
      runnableSnapshot([
        {
          path: "tests/unit.spec.js",
          content: 'import { describe, it, expect } from "vitest";\ndescribe("x", () => { it("y", () => expect(1).toBe(1)); });',
        },
      ]),
    );
    assert.equal(selection.runnable.length, 0);
    assert.equal(selection.skipped[0]?.reason, "needs-runner");
  });

  test("a bare import in the test file itself is reported with the package name", () => {
    const selection = selectRunnableTestFiles(
      runnableSnapshot([
        { path: "tests/api.test.js", content: 'import test from "node:test";\nimport { z } from "zod";\ntest("t", () => {});' },
      ]),
    );
    assert.equal(selection.runnable.length, 0);
    assert.equal(selection.skipped[0]?.reason, "needs-dependencies");
    assert.equal(selection.skipped[0]?.detail, "zod");
  });

  test("a bare import reached through a relative import is found too", () => {
    const selection = selectRunnableTestFiles(
      runnableSnapshot([
        { path: "tests/a.test.js", content: 'import test from "node:test";\nimport { helper } from "./helper";\ntest("t", () => helper());' },
        { path: "tests/helper.js", content: 'import lodash from "lodash";\nexport const helper = () => lodash;' },
      ]),
    );
    assert.equal(selection.runnable.length, 0);
    assert.equal(selection.skipped[0]?.detail, "lodash");
  });

  test("node builtins are never treated as external dependencies", () => {
    const selection = selectRunnableTestFiles(
      runnableSnapshot([
        { path: "tests/io.test.js", content: 'import test from "node:test";\nimport fs from "node:fs";\nimport path from "node:path";\ntest("t", () => { fs; path; });' },
      ]),
    );
    assert.equal(selection.runnable.length, 1);
  });

  test("the file cap turns extra candidates into an over-limit skip", () => {
    const files = ["a", "b", "c"].map((name) => ({ path: `tests/${name}.test.js`, content: NODE_TEST_FILE.replace("../src/add", "../../src/add") }));
    const selection = selectRunnableTestFiles(runnableSnapshot([...files, { path: "src/add.js", content: "export const add = (a, b) => a + b;" }]), {
      maxFiles: 2,
    });
    assert.equal(selection.runnable.length, 2);
    assert.deepEqual(
      selection.skipped.map((entry) => entry.reason),
      ["over-limit"],
    );
  });

  test("an oversized test file is skipped with its size", () => {
    const selection = selectRunnableTestFiles(
      runnableSnapshot([{ path: "tests/big.test.js", content: `${NODE_TEST_FILE}\n// ${"x".repeat(160_000)}` }]),
    );
    assert.equal(selection.skipped[0]?.reason, "too-large");
  });

  test("a non-test file is never a candidate, even with a node:test import", () => {
    const selection = selectRunnableTestFiles(runnableSnapshot([{ path: "src/main.js", content: NODE_TEST_FILE }]));
    assert.equal(selection.runnable.length + selection.skipped.length, 0);
  });
});

describe("workspace path containment", () => {
  test("relative paths inside the workspace are accepted", () => {
    assert.equal(safeJoin("/tmp/ws", "src/a.ts"), "/tmp/ws/src/a.ts");
    assert.equal(safeJoin("/tmp/ws", "a/b/c/d.test.js"), "/tmp/ws/a/b/c/d.test.js");
  });

  test("escaping paths, absolute paths and empty segments are refused", () => {
    for (const bad of ["../evil.ts", "a/../../evil.ts", "/etc/passwd", "", ".", "a/../../..", "..\\evil"]) {
      const resolved = safeJoin("/tmp/ws", bad);
      assert.ok(resolved === null || resolved.startsWith("/tmp/ws/"), `unexpected resolution for ${bad}`);
      if (bad.startsWith("/") || bad.includes("..") || bad === "" || bad === ".") assert.equal(resolved, null);
    }
  });
});

/* ------------------------------------------------------------------ TAP parsing */

const SAMPLE_TAP = [
  "TAP version 13",
  "# Subtest: numbers",
  "    # Subtest: adds",
  "    ok 1 - adds",
  "      ---",
  "      duration_ms: 0.9",
  "      ...",
  "    # Subtest: subtracts",
  "    not ok 2 - subtracts",
  "      ---",
  "      duration_ms: 1.4",
  "      location: '/tmp/ws/tests/calc.test.js:12:1'",
  "      failureType: 'testCodeFailure'",
  "      error: |-",
  "        Expected values to be strictly equal:",
  "        + actual - expected",
  "        + 'sk_live_LEAKEDVALUE123456'",
  "        - 1",
  "      code: 'ERR_ASSERTION'",
  "      stack: |-",
  "        TestContext.<anonymous> (file:///tmp/ws/tests/calc.test.js:14:14)",
  "        Test.runInAsyncScope (node:async_hooks:214:14)",
  "      ...",
  "not ok 1 - numbers",
  "  ---",
  "  duration_ms: 3.1",
  "  failureType: 'subtestFailed'",
  "  ...",
  "1..2",
  "# tests 2",
  "# suites 1",
  "# pass 1",
  "# fail 1",
  "# skipped 0",
  "# duration_ms 12.5",
].join("\n");

describe("TAP parsing", () => {
  const parsed = parseTap(SAMPLE_TAP, "/tmp/ws");

  test("counts come from the harness summary, not from counting lines", () => {
    assert.deepEqual(parsed.totals, { tests: 2, pass: 1, fail: 1, skipped: 0 });
    assert.equal(parsed.sawSummary, true);
  });

  test("only leaf results become cases, so a failing suite is not counted twice", () => {
    assert.deepEqual(
      parsed.cases.map((item) => item.name),
      ["adds", "subtracts"],
    );
    assert.equal(parsed.cases[0]?.ok, true);
    assert.equal(parsed.cases[1]?.ok, false);
  });

  test("a failing case points at the assertion frame inside the workspace, mapped to the repo path", () => {
    const failure = parsed.cases[1];
    assert.equal(failure?.file, "tests/calc.test.js");
    assert.equal(failure?.line, 14);
  });

  test("the failure message is masked before it is stored", () => {
    const failure = parsed.cases.find((item) => !item.ok);
    assert.ok(failure?.message);
    assert.ok(!failure.message?.includes("sk_live_LEAKEDVALUE123456"), "a secret shape must never be stored raw");
    assert.ok(failure.message?.includes("sk_live_********"));
  });

  test("a path outside the workspace maps to no repo file", () => {
    assert.deepEqual(toRepoPath("/etc/passwd:3:1", "/tmp/ws"), { file: null, line: 3 });
    assert.deepEqual(toRepoPath("/tmp/ws/a.ts:9:2", "/tmp/ws"), { file: "a.ts", line: 9 });
  });

  test("non-TAP output is reported as having no summary", () => {
    const empty = parseTap("some stray log line\n", "/tmp/ws");
    assert.equal(empty.sawSummary, false);
    assert.deepEqual(empty.cases, []);
  });
});

/* ------------------------------------------------------------------ guard source */

describe("execution guard", () => {
  test("the guard denies the network, process and DNS entry points", () => {
    for (const needle of [
      "globalThis.fetch",
      "globalThis.WebSocket",
      "net.Socket.prototype.connect",
      "dgram.Socket.prototype.",
      "child_process",
      "worker_threads",
      '"dns"',
    ]) {
      assert.ok(GUARD_SOURCE.includes(needle), `the guard must cover ${needle}`);
    }
  });

  test("the guard is written to be self-contained: no imports of project code", () => {
    assert.ok(!/from\s+["']\.\//.test(GUARD_SOURCE));
    assert.ok(GUARD_SOURCE.includes("__CODEAUDIT_SANDBOX__"));
  });
});

/* ------------------------------------------------------------------ real execution */

const GUARD_PROBES = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import fs from "node:fs";',
  "",
  'test("the environment is scrubbed", () => {',
  '  assert.equal(process.env.DATABASE_URL ?? "absent", "absent");',
  '  assert.equal(process.env.GITHUB_PUSH_TOKEN ?? "absent", "absent");',
  "});",
  "",
  'test("the filesystem is read-only", () => {',
  "  let blocked = false;",
  '  try { fs.writeFileSync("evil.txt", "x"); } catch { blocked = true; }',
  "  assert.equal(blocked, true);",
  "});",
  "",
  'test("the network is denied", async () => {',
  "  let blocked = false;",
  '  try { await fetch("https://example.com"); } catch { blocked = true; }',
  "  assert.equal(blocked, true);",
  "});",
].join("\n");

const BROKEN_FILE = ['import test from "node:test";', "(((", "this is not javascript"].join("\n");

const HANGING_FILE = ['import test from "node:test";', 'test("never finishes", () => { for (;;) { /* spin */ } });'].join("\n");

const FAILING_FILE = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'test("subtracts two numbers", () => {',
  "  const actual = 2 - 1;",
  "  assert.equal(actual, 3);",
  "});",
].join("\n");

async function sandboxDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith("codeaudit-sandbox-"));
}

describe("execution sandbox", () => {
  test("a run reports what really happened, and the workspace is removed afterwards", async () => {
    const before = (await sandboxDirs()).length;
    const result = await runSandbox(
      runnableSnapshot([
        { path: "tests/guards.test.js", content: GUARD_PROBES },
        { path: "tests/failing.test.js", content: FAILING_FILE },
      ]),
      { enabled: true, budgetMs: 15_000 },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.info.mode, "restricted-process");
    assert.deepEqual(
      result.info.files.sort(),
      ["tests/failing.test.js", "tests/guards.test.js"],
    );
    // Three guard probes pass, and the deliberate failure in the other file is the only failure.
    assert.equal(result.passed, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.total, 4);

    const failure = result.cases.find((item) => !item.ok);
    assert.equal(failure?.file, "tests/failing.test.js");
    assert.equal(failure?.line, 5, "the line of the failing assertion");
    assert.ok((failure?.message ?? "").length > 0);

    // The limits travel with the result: they are printed in the report.
    assert.equal(result.info.limits.memoryMb, 176);
    assert.equal(result.info.truncated, false);
    assert.deepEqual(result.info.crashed, []);

    assert.equal((await sandboxDirs()).length, before, "the temporary workspace must not survive the run");
  });

  test("a passing case still names the file it came from", async () => {
    const result = await runSandbox(
      runnableSnapshot([
        {
          path: "tests/passing.test.js",
          content: ['import test from "node:test";', 'import assert from "node:assert/strict";', 'test("adds up", () => { assert.equal(1 + 1, 2); });'].join("\n"),
        },
      ]),
      { enabled: true, budgetMs: 15_000 },
    );
    assert.equal(result.failed, 0);
    const single = result.cases[0];
    // Node's TAP omits `location:` for a passing result; the file it ran in is still evidence.
    assert.equal(single?.file, "tests/passing.test.js");
    assert.equal(single?.ok, true);
  });

  test("the environment inside the sandbox carries no platform secrets", async () => {
    const result = await runSandbox(
      runnableSnapshot([{ path: "tests/guards.test.js", content: GUARD_PROBES }]),
      { enabled: true, budgetMs: 15_000 },
    );
    // The probe asserts DATABASE_URL and GITHUB_PUSH_TOKEN are absent; if they leaked, it fails.
    assert.equal(result.failed, 0);
    assert.equal(result.passed, 3);
    assert.ok(!result.output.includes(process.env.DATABASE_URL ?? "no-database-url-in-this-process"));
  });

  test("a suite that cannot even load is reported as crashed, with no invented cases", async () => {
    const result = await runSandbox(
      runnableSnapshot([{ path: "tests/broken.test.js", content: BROKEN_FILE }]),
      { enabled: true, budgetMs: 15_000 },
    );
    assert.equal(result.info.crashed.length, 1);
    assert.equal(result.info.crashed[0]?.path, "tests/broken.test.js");
    assert.match(result.info.crashed[0]?.error ?? "", /Syntax|Unexpected/i);
    assert.equal(result.cases.length, 0);
    assert.equal(result.failed, 0);
  });

  test("a suite that never finishes is killed at the deadline", async () => {
    const result = await runSandbox(
      runnableSnapshot([
        { path: "tests/hang.test.js", content: HANGING_FILE },
      ]),
      { enabled: true, budgetMs: 2_500 },
    );
    assert.equal(result.status, "timeout");
    assert.equal(result.timedOutFile, "tests/hang.test.js");
    assert.ok(result.durationMs < 6_000, `the child must be killed, took ${result.durationMs} ms`);
  });

  test("execution is opt-in: a disabled run touches nothing", async () => {
    const result = await runSandbox(runnableSnapshot([{ path: "tests/guards.test.js", content: GUARD_PROBES }]), { enabled: false });
    assert.equal(result.status, "disabled");
    assert.equal(result.info.files.length, 0);
    assert.equal(result.output, "");
  });

  test("no runnable file means no execution, and the reasons are kept", async () => {
    const result = await runSandbox(
      runnableSnapshot([{ path: "tests/unit.spec.js", content: 'import { it } from "vitest";\nit("x", () => {});' }]),
      { enabled: true },
    );
    assert.equal(result.status, "no-candidates");
    assert.equal(result.info.skipped[0]?.reason, "needs-runner");
  });
});

/* ------------------------------------------------------------------ findings */

describe("executed results become evidence-backed findings", () => {
  test("a failing case produces TST-006 at the assertion line, with the sandbox recorded", async () => {
    const snapshot = runnableSnapshot([{ path: "tests/failing.test.js", content: FAILING_FILE }]);
    const execution = await runExecutionEngine(snapshot, { enabled: true, budgetMs: 15_000 });

    assert.equal(execution.executed, true);
    assert.equal(execution.testRun?.status, "executed");
    assert.equal(execution.testRun?.executed, true);
    assert.equal(execution.testRun?.mode, "restricted-process");
    assert.equal(execution.testRun?.sandbox?.limits.perFileMs, 8_000);

    const finding = execution.findings.find((item) => item.ruleId === "TST-006");
    assert.ok(finding, "a failing executed case must produce a finding");
    assert.equal(finding.filePath, "tests/failing.test.js");
    assert.equal(finding.lineStart, 5);
    assert.equal(finding.confidence, 0.99);
    assert.equal(finding.metadata?.mode, "restricted-process");
    assert.ok(finding.toolReference?.startsWith("sandbox:node-test:"));
    assert.ok(finding.snippet?.includes("subtracts two numbers"));
    assert.equal(finding.extraEvidence?.[0]?.sourceType, "test_result");

    for (const produced of execution.findings) {
      assert.ok(
        RULE_CATALOG.some((rule) => rule.id === produced.ruleId),
        `${produced.ruleId} must exist in the rule catalogue`,
      );
    }
  });

  test("a file that does not load produces TST-007, not a pile of failures", async () => {
    const snapshot = runnableSnapshot([{ path: "tests/broken.test.js", content: BROKEN_FILE }]);
    const execution = await runExecutionEngine(snapshot, { enabled: true, budgetMs: 15_000 });
    const rules = execution.findings.map((item) => item.ruleId);
    assert.ok(rules.includes("TST-007"));
    assert.ok(!rules.includes("TST-006"));
  });

  test("when nothing can run, no finding is invented", async () => {
    const execution = await runExecutionEngine(
      runnableSnapshot([{ path: "tests/unit.spec.js", content: 'import { it } from "vitest";\nit("x", () => {});' }]),
      { enabled: true },
    );
    assert.equal(execution.executed, false);
    assert.equal(execution.findings.length, 0);
    assert.equal(execution.testRun, null);
    assert.ok(execution.notes.length > 0);
  });
});
