import type { BilingualText, Severity } from "@/lib/types";
import { SEVERITY_VAR, SeverityBadge } from "./ui";
import { Icon } from "./icons";

export interface FindingListItem {
  id: string;
  ruleId: string;
  category: string;
  severity: Severity;
  status: string;
  title: BilingualText;
  filePath: string | null;
  lineStart: number | null;
  symbol: string | null;
  confidence: number;
  occurrences?: number;
}

export function FindingsList({
  findings,
  locale,
  severityLabels,
  statusLabels,
  categoryLabels,
  emptyLabel,
  compact = false,
}: {
  findings: FindingListItem[];
  locale: "ar" | "en";
  severityLabels: Record<string, string>;
  statusLabels: Record<string, string>;
  categoryLabels: Record<string, string>;
  emptyLabel: string;
  compact?: boolean;
}) {
  if (findings.length === 0) {
    return (
      <div className="panel-body">
        <p className="rounded-lg border border-dashed border-line/70 px-4 py-6 text-center text-sm text-muted">
          {emptyLabel}
        </p>
      </div>
    );
  }

  const statusClass: Record<string, string> = {
    open: "text-ink",
    confirmed: "text-medium",
    fixed: "text-brand",
    false_positive: "text-muted line-through",
    ignored: "text-muted",
  };

  return (
    <ul className="rows">
      {findings.map((finding) => (
        <li key={finding.id}>
          <a
            className="finding"
            href={`/findings/${finding.id}`}
            style={{ ["--sev" as string]: SEVERITY_VAR[finding.severity] }}
          >
            <div className="min-w-0 flex-1">
              <span dir="auto" className={`block text-sm font-medium ${statusClass[finding.status] ?? ""}`}>
                {finding.title[locale]}
              </span>
              <p className="row-meta">
                {finding.ruleId}
                {" · "}
                {categoryLabels[finding.category] ?? finding.category}
                {finding.filePath ? ` · ${finding.filePath}` : ""}
                {finding.lineStart ? `:${finding.lineStart}` : ""}
                {finding.symbol && !compact ? ` · ${finding.symbol}` : ""}
              </p>
              {!compact && finding.occurrences && finding.occurrences > 1 ? (
                <p className="mt-1 text-xs text-muted">
                  {locale === "ar"
                    ? `البصمة نفسها تظهر ${finding.occurrences} مرة`
                    : `Same fingerprint appears ${finding.occurrences} times`}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              <SeverityBadge severity={finding.severity} label={severityLabels[finding.severity]} />
              <span
                className="chip chip-mono"
                title={
                  locale === "ar"
                    ? "ثقة الكشف من الأداة — ليست احتمالًا رياضيًا"
                    : "Detection confidence from the tool — not a statistical probability"
                }
              >
                {Math.round(finding.confidence * 100)}%
              </span>
              <span className="chip">{statusLabels[finding.status] ?? finding.status}</span>
              <Icon name="chevron" size={14} className="finding-chevron rtl:rotate-180" />
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
