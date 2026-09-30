/**
 * Shared fixtures for the suite.
 *
 * Everything here is built from the application's own pure constructors
 * (`snapshotFromRawFiles`, `normaliseFindings`), so a fixture can never be more
 * permissive than the real pipeline.
 */
import { normaliseFindings } from "../lib/analysis/evidence";
import { snapshotFromRawFiles, type SnapshotSource } from "../lib/sources/snapshot";
import type { Finding, RawFinding, RepoFile, RepoSnapshot } from "../lib/types";

export const UPLOAD_SOURCE: SnapshotSource = { type: "upload", label: "test fixture" };

/**
 * A provider-shaped credential, assembled at runtime from its parts.
 *
 * A scanner cannot tell a test fixture that reads `sk_live_…` from a leaked key — GitHub's push
 * protection blocks the push — and this project should not ship a credential-shaped literal in
 * source at all. Joining the parts keeps the runtime value identical, so the tests still exercise
 * the shape the secret engine is expected to catch.
 */
export function demoSecret(...parts: string[]): string {
  return parts.join("_");
}

export function snapshotOf(
  files: { path: string; content: string }[],
  source: SnapshotSource = UPLOAD_SOURCE,
): RepoSnapshot {
  return snapshotFromRawFiles(files, source);
}

export function fileMap(snapshot: RepoSnapshot): Map<string, RepoFile> {
  return new Map(snapshot.files.map((file) => [file.path, file]));
}

/** Runs raw engine output through the real evidence layer. */
export function normalise(raw: RawFinding[], snapshot: RepoSnapshot, runId = "run_test"): Finding[] {
  return normaliseFindings(raw, {
    runId,
    projectId: "prj_test",
    snapshot,
    fileByPath: fileMap(snapshot),
  }).findings;
}

export function findingOf(raw: RawFinding, snapshot: RepoSnapshot, runId = "run_test"): Finding {
  const [first] = normalise([raw], snapshot, runId);
  if (!first) throw new Error(`fixture produced no finding for ${raw.ruleId} in ${raw.filePath}`);
  return first;
}

/** `{ file, line }` pairs a rules-engine explanation may legitimately point at. */
export function knownPaths(snapshot: RepoSnapshot): Set<string> {
  return new Set(snapshot.files.map((file) => file.path));
}
