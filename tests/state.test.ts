/**
 * Job state machine (§32) — `lib/analysis/state.ts`.
 *
 * The graph is what stops a long audit from skipping a stage and reporting a verdict it
 * never earned, so the tests walk it: every state is a node, the happy path is a real path
 * through it, and every non-terminal state can still end in COMPLETED, FAILED or CANCELLED.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ALLOWED_TRANSITIONS, canTransition, severityOrder, STAGE_LABEL, STAGE_SEQUENCE, StageEmitter } from "../lib/analysis/state";
import type { AuditStatus } from "../lib/types";

// The stage transitions are logged; the suite only cares about the graph.
process.env.LOG_LEVEL = "error";

/** Every member of the `AuditStatus` union in `lib/types.ts`, in declaration order. */
const ALL_STATUSES: AuditStatus[] = [
  "QUEUED",
  "CLONING",
  "DETECTING",
  "ANALYZING",
  "SECURITY_SCAN",
  "DEPENDENCY_SCAN",
  "TESTING",
  "ARCHITECTURE",
  "AI_REVIEW",
  "VERIFYING",
  "REPORTING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

const TERMINAL: AuditStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

function reachableFrom(start: AuditStatus): Set<AuditStatus> {
  const seen = new Set<AuditStatus>([start]);
  const queue: AuditStatus[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of ALLOWED_TRANSITIONS[current] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe("audit state machine", () => {
  test("every AuditStatus is a node of the graph", () => {
    assert.deepEqual(
      Object.keys(ALLOWED_TRANSITIONS),
      ALL_STATUSES,
      "ALLOWED_TRANSITIONS must cover every status, and only those",
    );
  });

  test("the graph only points at known statuses", () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      assert.ok(ALL_STATUSES.includes(from as AuditStatus), `${from} is not an AuditStatus`);
      for (const target of targets) {
        assert.ok(ALL_STATUSES.includes(target), `${from} -> ${target}: unknown target`);
        assert.notEqual(target, from, `${from} must not transition to itself`);
      }
      assert.equal(new Set(targets).size, targets.length, `${from} lists a transition twice`);
    }
  });

  test("STAGE_SEQUENCE is a valid path through the graph", () => {
    assert.equal(STAGE_SEQUENCE[0], "QUEUED", "the happy path starts at QUEUED");
    assert.equal(STAGE_SEQUENCE[STAGE_SEQUENCE.length - 1], "COMPLETED", "the happy path ends at COMPLETED");
    assert.equal(new Set(STAGE_SEQUENCE).size, STAGE_SEQUENCE.length, "a stage appears twice in STAGE_SEQUENCE");
    for (let index = 1; index < STAGE_SEQUENCE.length; index += 1) {
      const from = STAGE_SEQUENCE[index - 1];
      const to = STAGE_SEQUENCE[index];
      assert.ok(
        (ALLOWED_TRANSITIONS[from] ?? []).includes(to),
        `STAGE_SEQUENCE step ${from} -> ${to} is not an allowed transition`,
      );
    }
    assert.deepEqual(
      [...STAGE_SEQUENCE].sort(),
      ALL_STATUSES.filter((status) => !TERMINAL.includes(status) || status === "COMPLETED").sort(),
      "STAGE_SEQUENCE should cover every non-terminal stage plus COMPLETED",
    );
  });

  test("COMPLETED, FAILED and CANCELLED are terminal", () => {
    for (const status of TERMINAL) {
      assert.deepEqual(ALLOWED_TRANSITIONS[status], [], `${status} must have no outgoing transition`);
    }
  });

  test("every non-terminal state can reach COMPLETED, FAILED and CANCELLED", () => {
    for (const status of ALL_STATUSES) {
      if (TERMINAL.includes(status)) continue;
      const reachable = reachableFrom(status);
      for (const target of TERMINAL) {
        assert.ok(reachable.has(target), `${status} cannot reach ${target}`);
      }
    }
  });

  test("canTransition refuses a stage jump and accepts a legal step", () => {
    assert.equal(canTransition("QUEUED", "TESTING"), false, "QUEUED must not jump to TESTING");
    assert.equal(canTransition("QUEUED", "REPORTING"), false, "QUEUED must not jump to REPORTING");
    assert.equal(canTransition("REPORTING", "CLONING"), false, "REPORTING must not go back to CLONING");
    assert.equal(canTransition("COMPLETED", "REPORTING"), false, "a completed audit must not restart");
    assert.equal(canTransition("QUEUED", "CLONING"), true, "QUEUED -> CLONING is the first legal step");
    assert.equal(canTransition("QUEUED", "CANCELLED"), true, "a queued audit can be cancelled");
    assert.equal(canTransition("QUEUED", "FAILED"), true, "a queued audit can fail");
    // Documented behaviour: re-entering the current stage is treated as a no-op, not a jump.
    assert.equal(canTransition("QUEUED", "QUEUED"), true, "same-stage moves are allowed");
    assert.equal(
      canTransition("COMPLETED", "COMPLETED"),
      true,
      "a terminal state still allows a same-stage (progress) update",
    );
  });

  test("severityOrder ranks CRITICAL before INFO", () => {
    assert.equal(severityOrder("CRITICAL"), 0);
    assert.ok(severityOrder("CRITICAL") < severityOrder("HIGH"), "CRITICAL must outrank HIGH");
    assert.ok(severityOrder("HIGH") < severityOrder("MEDIUM"), "HIGH must outrank MEDIUM");
    assert.ok(severityOrder("MEDIUM") < severityOrder("LOW"), "MEDIUM must outrank LOW");
    assert.ok(severityOrder("LOW") < severityOrder("INFO"), "LOW must outrank INFO");
    assert.equal(severityOrder("INFO"), 4);
  });

  test("STAGE_LABEL has a bilingual label for every status", () => {
    for (const status of ALL_STATUSES) {
      const label = STAGE_LABEL[status];
      assert.ok(label, `${status} has no label`);
      assert.ok(label.ar.trim().length > 0, `${status} has no Arabic label`);
      assert.ok(label.en.trim().length > 0, `${status} has no English label`);
    }
  });

  test("the resolver hook keeps the suite off the database", async () => {
    // `lib/analysis/state.ts` imports the persistence layer, and `lib/engines/dependencies.ts`
    // does too. The loader points that module at an offline double for test processes; if the
    // hook ever stops matching, the real pool is imported and this fails loudly instead of the
    // suite quietly needing PostgreSQL.
    const db = await import("../lib/db");
    assert.throws(() => db.getPool(), /no database/, "the offline double should be in place");
  });

  test("StageEmitter refuses an illegal jump before it touches the database", async () => {
    const events: string[] = [];
    const emitter = new StageEmitter("job_test", (event) => events.push(event.stage));
    assert.equal(emitter.stage, "QUEUED", "the emitter starts at QUEUED");

    await assert.rejects(
      () => emitter.move("TESTING", 50),
      /invalid_transition:QUEUED->TESTING/,
      "a stage jump must be rejected",
    );
    assert.equal(emitter.stage, "QUEUED", "a rejected move must not change the stage");
    assert.deepEqual(events, [], "a rejected move must not stream an event");

    await emitter.move("CLONING", 5);
    assert.equal(emitter.stage, "CLONING");
    assert.deepEqual(events, ["CLONING"]);

    await assert.rejects(
      () => emitter.move("COMPLETED", 100),
      /invalid_transition:CLONING->COMPLETED/,
      "CLONING cannot jump straight to COMPLETED",
    );
    assert.deepEqual(emitter.snapshot().stages.map((entry) => entry.stage), ["CLONING"]);
  });
});
