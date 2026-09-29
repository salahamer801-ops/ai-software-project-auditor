import type { RawFinding } from "../types";
import type { EngineContext } from "./shared";
import { findLine, makeFinding, matchLines, snippetAround } from "./shared";

/**
 * Docker / CI / configuration engine (§16, §38): reads container and pipeline files as
 * text. Nothing is built and no image is pulled.
 */

const CI_FILE = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|Jenkinsfile|\.travis\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml)$/;

const SECRET_KEYS = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials|auth)/i;
const PLACEHOLDER = /(\$\{\{|\$\{|secrets\.|env\.|vault|changeme|example|placeholder|your[_-])/i;

export function runOpsEngine(ctx: EngineContext): RawFinding[] {
  const findings: RawFinding[] = [];
  const seen = new Set<string>();
  const emit = (finding: RawFinding) => {
    const key = `${finding.ruleId}:${finding.filePath}:${finding.lineStart ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  const hasDockerignore = ctx.files.some((file) => file.path === ".dockerignore" || file.path.endsWith("/.dockerignore"));
  const hasGitignore = ctx.files.some((file) => file.path === ".gitignore" || file.path.endsWith("/.gitignore"));

  for (const file of ctx.files) {
    const content = file.content ?? "";
    if (!content) continue;
    const name = file.path.split("/").pop() ?? file.path;

    /* ---------------------------- Dockerfile ---------------------------- */
    if (/^Dockerfile(\..+)?$/.test(name) || name === "Containerfile") {
      const lines = content.split("\n");

      const userLines = lines.filter((line) => /^\s*USER\s+/i.test(line));
      const nonRootUser = userLines.some((line) => !/^\s*USER\s+(root|0)\s*$/i.test(line));
      if (!nonRootUser) {
        const line = findLine(content, /^\s*(?:CMD|ENTRYPOINT)/im) ?? 1;
        emit(
          makeFinding({
            ruleId: "OPS-001",
            path: file.path,
            line,
            snippet: snippetAround(content, line, 4),
            confidence: 0.8,
            toolReference: `ops-engine:docker-user:${file.path}`,
            metadata: { userLines: userLines.map((row) => row.trim()) },
          }),
        );
      }

      for (const match of matchLines(content, /^\s*FROM\s+([^\s]+)/gim, 10)) {
        const image = match.match[1] ?? "";
        if (/:(?:latest)\s*$/i.test(image) || (!image.includes(":") && !image.includes("@sha256"))) {
          emit(
            makeFinding({
              ruleId: "OPS-002",
              path: file.path,
              line: match.line,
              snippet: match.text.trim(),
              confidence: 0.85,
              toolReference: `ops-engine:base-image:${file.path}:${match.line}`,
              metadata: { image },
            }),
          );
        }
      }

      for (const match of matchLines(content, /(curl|wget)[^|;&]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/gim, 5)) {
        emit(
          makeFinding({
            ruleId: "OPS-003",
            path: file.path,
            line: match.line,
            snippet: match.text.trim().slice(0, 300),
            confidence: 0.85,
            toolReference: `ops-engine:remote-script:${file.path}:${match.line}`,
          }),
        );
      }

      if (!hasDockerignore) {
        emit(
          makeFinding({
            ruleId: "OPS-006",
            path: file.path,
            line: 1,
            snippet: "No .dockerignore file exists in the repository.",
            confidence: 0.9,
            toolReference: `ops-engine:dockerignore:${file.path}`,
          }),
        );
      }
    }

    /* ------------------------- compose / orchestration ------------------- */
    if (/docker-compose\.ya?ml$/.test(name) || /(^|\/)docker-compose\.ya?ml$/.test(file.path)) {
      for (const match of matchLines(content, /(privileged\s*:\s*true|network_mode\s*:\s*["']?host|pid\s*:\s*["']?host|cap_add\s*:\s*\n?\s*-\s*(?:ALL|SYS_ADMIN))/gim, 5)) {
        emit(
          makeFinding({
            ruleId: "OPS-005",
            path: file.path,
            line: match.line,
            snippet: snippetAround(content, match.line, 2),
            confidence: 0.8,
            toolReference: `ops-engine:privileged:${file.path}:${match.line}`,
          }),
        );
      }
      for (const match of matchLines(content, /image\s*:\s*([^\s]+:latest|[^\s:]+)\s*$/gim, 10)) {
        const image = match.match[1] ?? "";
        if (/latest$/i.test(image) || !image.includes(":")) {
          emit(
            makeFinding({
              ruleId: "OPS-002",
              path: file.path,
              line: match.line,
              snippet: match.text.trim(),
              confidence: 0.8,
              toolReference: `ops-engine:compose-image:${file.path}:${match.line}`,
              metadata: { image },
            }),
          );
        }
      }
    }

    /* ------------------------------- CI files ---------------------------- */
    if (CI_FILE.test(file.path) || CI_FILE.test(`/${file.path}`)) {
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        const match = line.match(/^\s*([A-Za-z0-9_\-.]*):\s*(.+)$/);
        if (!match) return;
        const key = match[1]!;
        const value = match[2]!.trim().replace(/^["']|["']$/g, "");
        if (!SECRET_KEYS.test(key)) return;
        if (!value || value.length < 8) return;
        if (PLACEHOLDER.test(value)) return;
        emit(
          makeFinding({
            ruleId: "OPS-004",
            path: file.path,
            line: index + 1,
            snippet: `${key}: ********`,
            confidence: 0.85,
            toolReference: `ops-engine:ci-secret:${file.path}:${index + 1}`,
            metadata: { key, masked: `${value.slice(0, 3)}${"*".repeat(8)}${value.slice(-2)}` },
          }),
        );
      });
    }
  }

  if (!hasGitignore && ctx.files.length > 5) {
    const gitignoreAnchor =
      ctx.files.find((file) => /(^|\/)Dockerfile$/.test(file.path))?.path ?? ctx.files[0]!.path;
    emit(
      makeFinding({
        ruleId: "OPS-007",
        path: gitignoreAnchor,
        line: 1,
        snippet: "The repository has no .gitignore file.",
        confidence: 0.95,
        toolReference: "ops-engine:no-gitignore",
      }),
    );
  }

  return findings;
}
