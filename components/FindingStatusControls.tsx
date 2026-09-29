"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "./I18nProvider";
import { Icon } from "./icons";

const STATUSES = ["open", "confirmed", "fixed", "false_positive", "ignored"] as const;

export function FindingStatusControls({
  findingId,
  currentStatus,
  currentReason,
}: {
  findingId: string;
  currentStatus: string;
  currentReason: string | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [reason, setReason] = useState(currentReason ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setSaved(false);
        const response = await fetch(`/api/findings/${findingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status, reason }),
        });
        setBusy(false);
        if (response.ok) {
          setSaved(true);
          router.refresh();
        }
      }}
    >
      <div>
        <label className="label" htmlFor="finding-status">
          {t("finding.setStatus")}
        </label>
        <select
          id="finding-status"
          className="input"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(`finding.status.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="finding-reason">
          {t("finding.reason")}
        </label>
        <input
          id="finding-reason"
          className="input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={400}
        />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t("common.loading") : t("common.save")}
        </button>
        {saved ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-brand">
            <Icon name="check" size={14} />
            {t("finding.statusSaved")}
          </span>
        ) : null}
      </div>
      <p className="hint">{t("finding.fingerprintHint")}</p>
    </form>
  );
}
