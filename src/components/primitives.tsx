"use client";

import type { ReactNode } from "react";
import type { Severity } from "@/lib/agent/types";

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-[var(--radius)] border ${className}`}
      style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
    >
      {title && (
        <header
          className="flex items-center justify-between gap-3 border-b px-3 py-2"
          style={{ borderColor: "var(--border)", background: "var(--bg-sunken)" }}
        >
          <h2
            className="text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: "var(--text-muted)" }}
          >
            {title}
          </h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const SEVERITY_TOKENS: Record<Severity, { fg: string; bg: string }> = {
  critical: { fg: "var(--critical)", bg: "var(--critical-bg)" },
  serious: { fg: "var(--serious)", bg: "var(--serious-bg)" },
  moderate: { fg: "var(--moderate)", bg: "var(--moderate-bg)" },
  minor: { fg: "var(--minor)", bg: "var(--minor-bg)" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const token = SEVERITY_TOKENS[severity];
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ color: token.fg, background: token.bg }}
    >
      {severity}
    </span>
  );
}

export function Tag({
  children,
  fg = "var(--text-muted)",
  bg = "var(--bg-sunken)",
  border,
}: {
  children: ReactNode;
  fg?: string;
  bg?: string;
  border?: string;
}) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        color: fg,
        background: bg,
        border: border ? `1px solid ${border}` : undefined,
      }}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
} & Record<string, unknown>) {
  const styles =
    variant === "primary"
      ? { background: "var(--accent)", color: "var(--accent-text)", border: "1px solid transparent" }
      : variant === "danger"
        ? { background: "var(--critical-bg)", color: "var(--critical)", border: "1px solid var(--border)" }
        : { background: "transparent", color: "var(--text)", border: "1px solid var(--border-strong)" };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-[6px] px-3 py-1.5 text-[13px] font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
      style={styles}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => {
              const index = tabs.findIndex((t) => t.id === active);
              if (e.key === "ArrowRight") onChange(tabs[(index + 1) % tabs.length].id);
              if (e.key === "ArrowLeft") onChange(tabs[(index - 1 + tabs.length) % tabs.length].id);
            }}
            className="rounded-[6px] px-2.5 py-1 text-[12px] font-medium"
            style={{
              background: selected ? "var(--bg-raised)" : "transparent",
              color: selected ? "var(--text)" : "var(--text-muted)",
              border: `1px solid ${selected ? "var(--border-strong)" : "transparent"}`,
            }}
          >
            {tab.label}
            {typeof tab.count === "number" && (
              <span style={{ color: "var(--text-faint)" }}> {tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 py-8 text-center text-[13px]" style={{ color: "var(--text-faint)" }}>
      {children}
    </p>
  );
}
