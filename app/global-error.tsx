"use client";

import { useEffect } from "react";
import { logger } from "@/lib/observability/log";

/**
 * Last-resort boundary: it replaces the root layout, so neither globals.css nor the
 * language provider is guaranteed to be mounted — hence the inline styling and the
 * fixed Arabic + English copy.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("ui.global_error", { message: error?.message, digest: error?.digest });
  }, [error]);

  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#070b14",
          color: "#e9eefb",
          fontFamily:
            '"Segoe UI", "Noto Sans Arabic", "Noto Kufi Arabic", Tahoma, system-ui, -apple-system, sans-serif',
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "560px",
            border: "1px solid #21304a",
            borderRadius: "14px",
            background: "#0e1726",
            padding: "22px",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "11px",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#46d6bf",
            }}
          >
            CodeAudit
          </p>
          <h1 style={{ margin: "10px 0 0", fontSize: "20px", fontWeight: 600 }}>حدث خطأ غير متوقع</h1>
          <p style={{ margin: "6px 0 0", color: "#93a3bf", fontSize: "14px" }}>
            Something went wrong — we could not load the application.
          </p>
          <p style={{ margin: "10px 0 0", color: "#93a3bf", fontSize: "13px" }}>
            جرّب مرة أخرى، وإن تكرّر الخطأ فأعد تحميل الصفحة لاحقًا. / Please try again, and reload later if it repeats.
          </p>

          {error?.digest ? (
            <p style={{ margin: "12px 0 0", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "12px", color: "#93a3bf" }}>
              fault id: {error.digest}
            </p>
          ) : null}

          <div style={{ marginTop: "18px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                border: "1px solid #2c3d5c",
                borderRadius: "9px",
                background: "#46d6bf",
                color: "#04231d",
                padding: "8px 14px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              إعادة المحاولة / Try again
            </button>
            <a
              href="/"
              style={{
                border: "1px solid #2c3d5c",
                borderRadius: "9px",
                background: "transparent",
                color: "#e9eefb",
                padding: "8px 14px",
                fontSize: "13px",
                textDecoration: "none",
              }}
            >
              الصفحة الرئيسية / Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
