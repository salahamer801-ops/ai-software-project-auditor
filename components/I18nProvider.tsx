"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Locale } from "../lib/types";
import { DICT } from "../lib/i18n/dict";

interface I18nValue {
  locale: Locale;
  dir: "rtl" | "ltr";
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue>({
  locale: "ar",
  dir: "rtl",
  t: (key) => key,
});

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const dict = DICT;
    return {
      locale,
      dir: locale === "ar" ? "rtl" : "ltr",
      t: (key: string, vars?: Record<string, string | number>) => {
        const entry = dict[key];
        let text = entry ? entry[locale] : key;
        if (vars) {
          for (const [name, replacement] of Object.entries(vars)) {
            text = text.replaceAll(`{${name}}`, String(replacement));
          }
        }
        return text;
      },
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
