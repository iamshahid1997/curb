"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Scroll reveal                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Reveals children once they scroll into view.
 *
 * Starts revealed and is hidden only by CSS inside a
 * `prefers-reduced-motion: no-preference` block, so a reader who has asked for
 * less motion — or anyone without JS — gets the content immediately rather than
 * a blank page waiting on an animation that will never run.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(true);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const el = ref.current;
    if (!el) return;

    setRevealed(false);

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setTimeout(() => setRevealed(true), delay);
        observer.disconnect();
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div ref={ref} className={`curb-reveal ${className}`} data-revealed={revealed}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Theme                                                                      */
/* -------------------------------------------------------------------------- */

type Theme = "light" | "dark" | "system";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const stored = (localStorage.getItem("curb-theme") as Theme | null) ?? "system";
    setTheme(stored);
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    localStorage.setItem("curb-theme", next);
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
  };

  const options: Array<{ id: Theme; label: string; glyph: string }> = [
    { id: "light", label: "Light", glyph: "☀" },
    { id: "system", label: "System", glyph: "◐" },
    { id: "dark", label: "Dark", glyph: "☾" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-full p-0.5"
      style={{ border: "1px solid var(--border)", background: "var(--bg-raised)" }}
    >
      {options.map((option) => {
        const active = theme === option.id;
        return (
          <button
            key={option.id}
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            onClick={() => apply(option.id)}
            className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] leading-none"
            style={{
              background: active ? "var(--text)" : "transparent",
              color: active ? "var(--bg)" : "var(--text-faint)",
            }}
          >
            <span aria-hidden="true">{option.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Copyable command                                                           */
/* -------------------------------------------------------------------------- */

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="inline-flex items-center gap-3 rounded-lg px-3.5 py-2.5"
      style={{ border: "1px solid var(--border-strong)", background: "var(--bg-raised)" }}
    >
      <code
        className="text-[13.5px]"
        style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
      >
        <span style={{ color: "var(--text-faint)" }}>$ </span>
        {command}
      </code>
      <button
        onClick={copy}
        className="rounded px-2 py-1 text-[11px] font-medium"
        style={{
          border: "1px solid var(--border)",
          color: copied ? "var(--ok)" : "var(--text-muted)",
          background: copied ? "var(--ok-bg)" : "transparent",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {/* Announce the result rather than relying on the visual change alone. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Command copied to clipboard" : ""}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  return (
    // scroll-mt keeps an anchored heading clear of the sticky header.
    <section
      id={id}
      className="mx-auto w-full max-w-[1080px] scroll-mt-20 px-6 py-20 md:py-28"
    >
      <Reveal>
        {eyebrow && (
          <p
            className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--accent-ink)" }}
          >
            {eyebrow}
          </p>
        )}
        <h2 className="max-w-[22ch] text-[clamp(1.6rem,3.4vw,2.4rem)] font-semibold leading-[1.12] tracking-[-0.02em]">
          {title}
        </h2>
        {lede && (
          <div
            className="mt-4 max-w-[62ch] text-[15px] leading-[1.65]"
            style={{ color: "var(--text-muted)" }}
          >
            {lede}
          </div>
        )}
      </Reveal>
      {children && <div className="mt-10">{children}</div>}
    </section>
  );
}

export function Card({
  children,
  accent,
  className = "",
}: {
  children: ReactNode;
  accent?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl p-5 ${className}`}
      style={{
        border: `1px solid ${accent ?? "var(--border)"}`,
        background: "var(--bg-raised)",
      }}
    >
      {children}
    </div>
  );
}
