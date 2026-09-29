import type { RepoSnapshot } from "../types";

/**
 * Evidence grounding for AI output (§29): every file/line the model refers to must exist
 * in the analysed manifest with a valid line number. Anything else is rejected and
 * recorded in the review so the user can see that verification happened.
 */
export function findingEvidenceRefs(
  refs: { file?: string; line?: number }[] | undefined,
  snapshot: RepoSnapshot,
  fileContents: Map<string, string>,
  dropReason = "not present in the analysed files",
): { accepted: { file: string; line?: number }[]; rejected: { file: string; line?: number; reason: string }[] } {
  const accepted: { file: string; line?: number }[] = [];
  const rejected: { file: string; line?: number; reason: string }[] = [];
  const known = new Set(snapshot.files.map((file) => file.path));

  for (const ref of refs ?? []) {
    const file = (ref?.file ?? "").trim().replace(/^\.\//, "");
    if (!file || !known.has(file)) {
      rejected.push({ file: ref?.file ?? "(missing)", line: ref?.line, reason: `file ${dropReason}` });
      continue;
    }
    const content = fileContents.get(file) ?? "";
    const lineCount = content ? content.split("\n").length : 0;
    if (ref?.line !== undefined && ref.line !== null) {
      const line = Number(ref.line);
      if (!Number.isFinite(line) || line < 1 || (lineCount > 0 && line > lineCount)) {
        rejected.push({ file, line, reason: `line outside the file (1..${lineCount || "unknown"})` });
        continue;
      }
      accepted.push({ file, line });
      continue;
    }
    accepted.push({ file });
  }

  return { accepted: accepted.slice(0, 12), rejected: rejected.slice(0, 12) };
}
