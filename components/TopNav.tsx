"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { useI18n } from "./I18nProvider";
import { Icon } from "./icons";
import { LocaleSwitch, LoginButton, LogoutButton } from "./NavActions";

export function TopNav({
  user,
}: {
  user: { name: string; email: string } | null;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const links = [
    { href: "/dashboard", label: t("nav.dashboard"), icon: "activity" },
    { href: "/projects/new", label: t("nav.newProject"), icon: "plus" },
    { href: "/about", label: t("nav.about"), icon: "layers" },
    { href: "/settings", label: t("nav.settings"), icon: "user" },
    { href: "/privacy", label: t("nav.privacy"), icon: "shield" },
  ];

  const isActive = (href: string) => pathname === href || (href !== "/dashboard" && pathname.startsWith(href));

  return (
    <header className="no-print sticky top-0 z-20 border-b border-line/70 bg-canvas/90 backdrop-blur">
      <div className="shell flex h-14 items-center gap-3">
        <a href={user ? "/dashboard" : "/"} className="flex shrink-0 items-center gap-2" aria-label="CodeAudit">
          <span className="brand-mark">
            <Icon name="shield" size={16} />
          </span>
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">
            Code<span className="text-brand">Audit</span>
          </span>
        </a>

        <nav aria-label="main" className="hidden flex-1 items-center gap-0.5 md:flex">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={`nav-link gap-1.5 ${isActive(link.href) ? "nav-link-active" : ""}`}
              aria-current={isActive(link.href) ? "page" : undefined}
            >
              <Icon name={link.icon} size={14} />
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-1.5 md:ms-0">
          {user ? (
            <>
              <span className="chip hidden items-center gap-1.5 sm:inline-flex" title={user.email}>
                <Icon name="user" size={12} />
                <span className="max-w-[8rem] truncate">{user.name}</span>
              </span>
              <LogoutButton />
            </>
          ) : (
            <LoginButton />
          )}
          <LocaleSwitch />
          <button
            type="button"
            className="btn btn-ghost btn-icon md:hidden"
            aria-label="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "close" : "layers"} size={16} />
          </button>
        </div>
      </div>

      {open ? (
        <nav aria-label="main-mobile" className="shell grid gap-1 border-t border-line/70 py-2 md:hidden">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={`nav-link gap-2 ${isActive(link.href) ? "nav-link-active" : ""}`}
              onClick={() => setOpen(false)}
            >
              <Icon name={link.icon} size={15} />
              {link.label}
            </a>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
