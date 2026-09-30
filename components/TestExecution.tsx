import { Chip, CodeBlock, StatusBadge } from "./ui";
import { Icon } from "./icons";
import type { TestRunRecord } from "@/lib/types";

/**
 * What an executed run actually did (§24, §34).
 *
 * This component is the visible half of the sandbox contract: the counts come from the runner's
 * own summary, every failing case shows the file and line the assertion failed on, the files that
 * were *not* run are listed with the reason, and the limits are printed next to the result — with
 * the sentence that says this is in-process isolation, not a container. A run that only detected
 * tests statically says that too, instead of looking like a pass.
 */
export function TestExecutionDetails({
  testRun,
  t,
  locale,
}: {
  testRun: TestRunRecord;
  t: (key: string) => string;
  locale: string;
}) {
  const cases = testRun.cases ?? [];
  const sandbox = testRun.sandbox ?? null;
  const failed = cases.filter((item) => !item.ok && !item.skipped);
  const shown = [...failed, ...cases.filter((item) => item.ok || item.skipped)].slice(0, 12);

  if (!testRun.executed) {
    return (
      <div className="panel-body">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <StatusBadge tone="neutral">{t("tests.detectedOnly")}</StatusBadge>
          <span>{t("tests.notRequested")}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="panel-body space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={testRun.failed && testRun.failed > 0 ? "bad" : "ok"}>{t("tests.executed")}</StatusBadge>
        <Chip mono>{testRun.mode ?? "restricted-process"}</Chip>
        {testRun.durationMs !== null ? (
          <Chip mono>
            {t("sandbox.duration")}: {testRun.durationMs} ms
          </Chip>
        ) : null}
        {sandbox ? (
          <Chip mono>
            {t("sandbox.limits")}: {sandbox.limits.perFileMs} ms/file · {sandbox.limits.memoryMb} MB ·{" "}
            {sandbox.limits.maxFiles} files
          </Chip>
        ) : null}
        {sandbox ? <Chip mono>{sandbox.environment.env} env · {sandbox.environment.filesystem} fs</Chip> : null}
      </div>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span className="text-muted">
          {t("tests.passed")}: <strong className="text-ink">{testRun.passed ?? 0}</strong>
        </span>
        <span className="text-muted">
          {t("tests.failed")}:{" "}
          <strong className={testRun.failed ? "text-critical" : "text-ink"}>{testRun.failed ?? 0}</strong>
        </span>
        <span className="text-muted">
          {t("tests.skipped")}: <strong className="text-ink">{testRun.skipped ?? 0}</strong>
        </span>
        {sandbox ? (
          <span className="text-muted">
            {t("tests.testFiles")}: <strong className="text-ink">{sandbox.files.length}</strong>
          </span>
        ) : null}
      </p>

      {shown.length > 0 ? (
        <ul className="rows">
          {shown.map((item, index) => (
            <li key={`${item.file}-${item.name}-${index}`} className="row">
              <Icon
                name={item.skipped ? "clock" : item.ok ? "check" : "alert"}
                size={15}
                className={item.skipped ? "text-muted" : item.ok ? "text-brand" : "text-critical"}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">{item.name}</span>
                  {item.line ? (
                    <span className="mono text-[11px] text-muted">
                      {item.file}:{item.line}
                    </span>
                  ) : (
                    <span className="mono text-[11px] text-muted">{item.file}</span>
                  )}
                </div>
                {item.message ? (
                  <p className="mono mt-1 whitespace-pre-wrap break-words text-[11px] text-critical/90">{item.message.slice(0, 400)}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {sandbox && sandbox.crashed.length > 0 ? (
        <details className="rounded-lg border border-line/70 p-3">
          <summary className="cursor-pointer text-sm text-ink">
            {t("sandbox.crashedFiles")} <span className="text-muted">({sandbox.crashed.length})</span>
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {sandbox.crashed.map((item) => (
              <li key={item.path}>
                <span className="mono text-muted">{item.path}</span>
                <p className="mono whitespace-pre-wrap break-words text-[11px] text-critical/90">{item.error}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {sandbox && sandbox.skipped.length > 0 ? (
        <details className="rounded-lg border border-line/70 p-3">
          <summary className="cursor-pointer text-sm text-ink">
            {t("sandbox.notRunFiles")} <span className="text-muted">({sandbox.skipped.length})</span>
          </summary>
          <ul className="mt-2 space-y-2 text-xs">
            {sandbox.skipped.map((item) => (
              <li key={item.path}>
                <span className="mono text-muted">{item.path}</span>
                <p className="text-muted">{t(`sandbox.${reasonKey(item.reason)}`)}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {testRun.outputExcerpt ? (
        <details>
          <summary className="cursor-pointer text-sm text-ink">{t("sandbox.output")}</summary>
          <div className="mt-2">
            <CodeBlock code={testRun.outputExcerpt} label={testRun.command ?? undefined} />
          </div>
        </details>
      ) : null}

      <p className="text-xs text-muted">{t("sandbox.notAContainer")}</p>
      {testRun.truncated ? <p className="text-xs text-warn">{locale === "ar" ? "تم اقتصاص القائمة عند الحد." : "The list was cut at the analysis limit."}</p> : null}
    </div>
  );
}

/** Maps the engine's reason codes to dictionary keys. */
function reasonKey(reason: string): string {
  const map: Record<string, string> = {
    "needs-runner": "needsRunner",
    "needs-dependencies": "needsDependencies",
    "too-large": "tooLarge",
    "unsupported-language": "unsupportedLanguage",
    "over-limit": "overLimit",
  };
  return map[reason] ?? "needsRunner";
}
