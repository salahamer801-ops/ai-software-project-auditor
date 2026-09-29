import type { ReactNode } from "react";
import { Icon } from "./icons";

/* ------------------------------------------------------------------ *
 * Page-level structure
 * ------------------------------------------------------------------ */

export function PageHeader({
  crumb,
  title,
  sub,
  meta,
  actions,
}: {
  crumb?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="min-w-0">
        {crumb ? <div className="mb-1.5">{crumb}</div> : null}
        <h1 className="page-title">{title}</h1>
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="btn-group shrink-0">{actions}</div> : null}
    </header>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="breadcrumb">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="inline-flex items-center gap-1.5">
          {index > 0 ? <Icon name="chevron" size={12} className="rtl:rotate-180" /> : null}
          {item.href ? <a href={item.href}>{item.label}</a> : <span className="text-ink/80">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function Tabs({
  items,
  label,
}: {
  items: { href: string; label: string; active: boolean; count?: number }[];
  label: string;
}) {
  return (
    <nav className="tabs border-b border-line/70" aria-label={label}>
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          className={`tab ${item.active ? "tab-active" : ""}`}
          aria-current={item.active ? "page" : undefined}
        >
          <span>{item.label}</span>
          {typeof item.count === "number" ? <span className="tab-count">{item.count}</span> : null}
        </a>
      ))}
    </nav>
  );
}

export function Toolbar({
  children,
  action,
  method = "get",
  className = "",
}: {
  children: ReactNode;
  action?: string;
  method?: string;
  className?: string;
}) {
  return (
    <form className={`toolbar ${className}`} method={method} action={action}>
      {children}
    </form>
  );
}

export function Field({
  label,
  htmlFor,
  wide = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`field ${wide ? "field-wide" : ""}`}>
      <label className="toolbar-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Panels — the single frame used everywhere
 * ------------------------------------------------------------------ */

export function Panel({
  title,
  sub,
  icon,
  action,
  footer,
  children,
  className = "",
  bodyClassName = "",
  flush = false,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  icon?: string;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section className={`panel ${className}`} id={id}>
      {title || action ? (
        <header className="panel-head">
          <div className="min-w-0">
            <h2 className="panel-title flex items-center gap-2">
              {icon ? <Icon name={icon} size={15} className="text-muted" /> : null}
              <span className="truncate">{title}</span>
            </h2>
            {sub ? <div className="panel-sub mt-0.5">{sub}</div> : null}
          </div>
          {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={flush ? bodyClassName : `panel-body ${bodyClassName}`}>{children}</div>
      {footer ? <div className="panel-foot">{footer}</div> : null}
    </section>
  );
}

export function Card({
  children,
  className = "",
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function SectionHeading({
  title,
  sub,
  action,
  icon,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="section-title flex items-center gap-2">
          {icon ? <Icon name={icon} size={16} className="text-muted" /> : null}
          {title}
        </h2>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tiles, badges, chips
 * ------------------------------------------------------------------ */

const TONE_TEXT: Record<string, string> = {
  neutral: "text-ink",
  ok: "text-brand",
  warn: "text-medium",
  bad: "text-critical",
  info: "text-low",
};

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "bad" | "info";
  icon?: string;
}) {
  return (
    <div className="tile">
      <div className="tile-label">
        {icon ? <Icon name={icon} size={14} /> : null}
        <span className="truncate">{label}</span>
      </div>
      <div className={`tile-value ${TONE_TEXT[tone]}`}>{value}</div>
      {hint ? <div className="tile-hint">{hint}</div> : null}
    </div>
  );
}

/** Back-compat alias. */
export const Stat = StatTile;

const SEVERITY_CLASS: Record<string, string> = {
  CRITICAL: "border-critical/40 bg-critical/10 text-critical",
  HIGH: "border-high/40 bg-high/10 text-high",
  MEDIUM: "border-medium/40 bg-medium/10 text-medium",
  LOW: "border-low/40 bg-low/10 text-low",
  INFO: "border-info/40 bg-info/10 text-info",
};

export const SEVERITY_VAR: Record<string, string> = {
  CRITICAL: "var(--color-critical)",
  HIGH: "var(--color-high)",
  MEDIUM: "var(--color-medium)",
  LOW: "var(--color-low)",
  INFO: "var(--color-info)",
};

export function SeverityBadge({ severity, label }: { severity: string; label: string }) {
  const cls = SEVERITY_CLASS[severity] ?? SEVERITY_CLASS.INFO;
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}

export function StatusBadge({ tone, children }: { tone: "ok" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  const map = {
    ok: "border-brand/40 bg-brand/10 text-brand",
    warn: "border-medium/40 bg-medium/10 text-medium",
    bad: "border-critical/40 bg-critical/10 text-critical",
    neutral: "border-line bg-surface2/60 text-muted",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

export function Chip({ children, mono = false, brand = false }: { children: ReactNode; mono?: boolean; brand?: boolean }) {
  return <span className={`chip ${mono ? "chip-mono" : ""} ${brand ? "chip-brand" : ""}`}>{children}</span>;
}

/* ------------------------------------------------------------------ *
 * Charts and progress
 * ------------------------------------------------------------------ */

export function SeverityBars({
  counts,
  labels,
  total,
  compact = false,
}: {
  counts: Record<string, number>;
  labels: Record<string, string>;
  total?: number;
  compact?: boolean;
}) {
  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
  const sum = total ?? order.reduce((acc, severity) => acc + (counts[severity] ?? 0), 0);
  if (sum === 0) {
    return <p className="text-sm text-muted">—</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface2/80">
        {order.map((severity) =>
          (counts[severity] ?? 0) > 0 ? (
            <div
              key={severity}
              style={{ width: `${((counts[severity] ?? 0) / sum) * 100}%`, background: SEVERITY_VAR[severity] }}
              title={`${labels[severity]}: ${counts[severity]}`}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {order.map((severity) => (
          <span key={severity} className="inline-flex items-center gap-1.5 text-muted">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEVERITY_VAR[severity] }} />
            {!compact ? <span>{labels[severity]}</span> : null}
            <strong className="text-ink">{counts[severity] ?? 0}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function TrendLine({ points, label }: { points: { label: string; value: number }[]; label?: string }) {
  if (points.length < 2) {
    return <p className="py-6 text-center text-sm text-muted">{label ?? "—"}</p>;
  }
  const width = 640;
  const height = 120;
  const pad = 10;
  const max = Math.max(...points.map((point) => point.value), 1);
  const step = (width - pad * 2) / (points.length - 1);
  const coords = points.map((point, index) => [
    pad + index * step,
    height - pad - (point.value / max) * (height - pad * 2),
  ]);
  const line = coords.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x!.toFixed(1)},${y!.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1]![0]!.toFixed(1)},${height - pad} L${coords[0]![0]!.toFixed(1)},${height - pad} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-28 w-full" role="img" aria-label={label ?? "trend"}>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={pad}
            x2={width - pad}
            y1={pad + (height - pad * 2) * ratio}
            y2={pad + (height - pad * 2) * ratio}
            stroke="var(--color-line)"
            strokeDasharray="3 5"
            strokeWidth="1"
          />
        ))}
        <path d={area} fill="var(--color-brand)" opacity="0.12" />
        <path d={line} fill="none" stroke="var(--color-brand)" strokeWidth="2" strokeLinecap="round" />
        {coords.map(([x, y], index) => (
          <circle key={index} cx={x} cy={y} r="3" fill="var(--color-canvas)" stroke="var(--color-brand)" strokeWidth="2">
            <title>{`${points[index]!.label}: ${points[index]!.value}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{points[0]!.label}</span>
        <span>
          {max} ⟵ {label ?? ""}
        </span>
        <span>{points[points.length - 1]!.label}</span>
      </div>
    </div>
  );
}

export function Progress({ value, tone = "info" }: { value: number; tone?: "info" | "ok" | "bad" }) {
  const color = tone === "ok" ? "bg-brand" : tone === "bad" ? "bg-critical" : "bg-low";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface2/80">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${Math.min(100, Math.max(2, value))}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Text blocks
 * ------------------------------------------------------------------ */

export function Callout({
  tone = "info",
  icon,
  title,
  children,
}: {
  tone?: "info" | "ok" | "warn" | "bad";
  icon?: string;
  title?: ReactNode;
  children?: ReactNode;
}) {
  const fallback = tone === "ok" ? "check" : tone === "bad" ? "alert" : tone === "warn" ? "alert" : "activity";
  return (
    <div className={`callout callout-${tone}`} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={icon ?? fallback} size={16} className="callout-icon" />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5 text-sm opacity-90" : ""}>{children}</div> : null}
      </div>
    </div>
  );
}

export function KeyValue({ items, columns = 2 }: { items: { label: string; value: ReactNode }[]; columns?: 1 | 2 | 3 }) {
  const cls = columns === 1 ? "grid-cols-1" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <dl className={`grid gap-x-4 gap-y-3 ${cls}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="kv-term">{item.label}</dt>
          <dd className="kv-value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CodeBlock({ code, startLine = 1, label }: { code: string; startLine?: number; label?: string }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <figure className="overflow-hidden rounded-lg border border-line bg-canvas/80">
      {label ? <figcaption className="mono border-b border-line/70 px-3 py-1.5 text-[11px] text-muted">{label}</figcaption> : null}
      <pre className="mono max-h-72 overflow-auto p-3 text-xs leading-relaxed">
        <code>
          {lines.map((line, index) => (
            <div key={index} className="flex gap-3">
              <span className="w-8 shrink-0 select-none text-end text-muted/50">{startLine + index}</span>
              <span className="whitespace-pre-wrap break-all">{line || " "}</span>
            </div>
          ))}
        </code>
      </pre>
    </figure>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon = "folder",
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line/70 px-4 py-8 text-center">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-surface2/60 text-muted">
        <Icon name={icon} size={18} />
      </span>
      <p className="font-medium text-ink">{title}</p>
      {body ? <p className="max-w-md text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-2 flex justify-center">{action}</div> : null}
    </div>
  );
}
