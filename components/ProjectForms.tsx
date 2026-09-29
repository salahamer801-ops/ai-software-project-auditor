"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "./I18nProvider";
import { Callout } from "./ui";
import { Icon } from "./icons";

const ERROR_KEYS: Record<string, string> = {
  invalid_repo: "project.new.invalidRepo",
  invalid_archive: "project.new.invalidArchive",
  too_large: "project.new.tooLarge",
  forbidden: "common.error",
  unauthorized: "common.error",
};

type SourceKind = "github" | "upload" | "demo";

export function NewProjectForm() {
  const { t } = useI18n();
  const router = useRouter();
  const [source, setSource] = useState<SourceKind>("github");
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [ref, setRef] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let response: Response;
      if (source === "upload") {
        if (!file) {
          setError(t("project.new.invalidArchive"));
          setBusy(false);
          return;
        }
        const form = new FormData();
        form.append("archive", file);
        form.append("name", name);
        form.append("ref", ref);
        response = await fetch("/api/projects/upload", { method: "POST", body: form });
      } else {
        response = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, sourceType: source, repositoryUrl, ref }),
        });
      }
      const data = (await response.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!response.ok || !data.jobId) {
        setError(t(ERROR_KEYS[data.error ?? ""] ?? "common.error"));
        setBusy(false);
        return;
      }
      router.push(`/audits/${data.jobId}`);
    } catch {
      setError(t("common.error"));
      setBusy(false);
    }
  }

  const options: { id: SourceKind; title: string; hint: string; icon: string }[] = [
    { id: "github", title: t("project.new.github"), hint: t("project.new.githubHint"), icon: "globe" },
    { id: "upload", title: t("project.new.upload"), hint: t("project.new.uploadHint"), icon: "package" },
    { id: "demo", title: t("project.new.demo"), hint: t("project.new.demoHint"), icon: "sparkles" },
  ];

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend className="eyebrow mb-2">{t("project.new.source")}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {options.map((option) => (
            <label
              key={option.id}
              className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 transition-colors ${
                source === option.id
                  ? "border-brand/60 bg-brand/5"
                  : "border-line bg-surface2/20 hover:border-line2 hover:bg-surface2/40"
              }`}
            >
              <input
                type="radio"
                name="source"
                className="sr-only"
                checked={source === option.id}
                onChange={() => setSource(option.id)}
              />
              <span className={`flex items-center gap-2 text-sm font-medium ${source === option.id ? "text-brand" : ""}`}>
                <Icon name={option.icon} size={15} />
                {option.title}
              </span>
              <span className="text-xs text-muted">{option.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {source !== "demo" ? (
          <div className={source === "upload" ? "sm:col-span-2" : ""}>
            <label className="label" htmlFor="project-name">
              {t("project.new.name")}
            </label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={source === "github" ? "owner/repo" : "My project"}
            />
          </div>
        ) : null}

        {source === "github" ? (
          <>
            <div>
              <label className="label" htmlFor="repo-url">
                {t("project.new.repoUrl")}
              </label>
              <input
                id="repo-url"
                className="input mono"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="repo-ref">
                {t("project.new.branch")} <span className="text-muted">({t("common.optional")})</span>
              </label>
              <input
                id="repo-ref"
                className="input mono"
                value={ref}
                onChange={(event) => setRef(event.target.value)}
                placeholder="main"
              />
              <p className="hint">{t("project.new.branchHint")}</p>
            </div>
          </>
        ) : null}
      </div>

      {source === "upload" ? (
        <div>
          <label className="label" htmlFor="archive">
            {t("project.new.upload")}
          </label>
          <input
            id="archive"
            type="file"
            accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip,application/x-tar"
            className="input h-auto py-1.5 file:me-3 file:rounded-md file:border-0 file:bg-surface2 file:px-2 file:py-1 file:text-xs file:text-ink"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
          <p className="hint">{t("project.new.uploadHint")}</p>
        </div>
      ) : null}

      {error ? <Callout tone="bad">{error}</Callout> : null}

      <div className="divider pt-4">
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          <Icon name={busy ? "refresh" : "activity"} size={16} />
          {busy ? t("project.new.creating") : t("project.new.create")}
        </button>
      </div>
    </form>
  );
}

export function DeleteProjectButton({ projectId, label }: { projectId: string; label: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
        <Icon name="trash" size={15} />
        {label}
      </button>
    );
  }
  return (
    <span className="btn-group">
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
          if (response.ok) {
            router.push("/dashboard");
            return;
          }
          setBusy(false);
          alert(t("common.error"));
        }}
      >
        <Icon name="trash" size={15} />
        {busy ? t("common.loading") : t("common.delete")}
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
        {t("common.cancel")}
      </button>
    </span>
  );
}
