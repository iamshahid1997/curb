"use client";

import Link from "next/link";
import { ThemeToggle } from "./landing";

/**
 * Shared site chrome.
 *
 * Extracted so the landing page and the playground cannot drift apart — the
 * playground previously had no header at all, which made clicking through from
 * the landing page feel like leaving the site.
 */
export function SiteHeader({ current }: { current?: "playground" }) {
  return (
    <header
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{
        borderColor: "var(--border)",
        background: "color-mix(in srgb, var(--bg) 82%, transparent)",
      }}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-[1400px] items-center gap-6 px-5 py-3.5"
      >
        <Link href="/" className="text-[15px] font-semibold tracking-[-0.01em]">
          Curb
        </Link>

        <div className="ml-auto flex items-center gap-5 text-[13px]">
          <Link
            href="/#how"
            className="hidden sm:inline"
            style={{ color: "var(--text-muted)" }}
          >
            How it works
          </Link>
          <Link
            href="/playground"
            className="hidden sm:inline"
            aria-current={current === "playground" ? "page" : undefined}
            style={{ color: current === "playground" ? "var(--text)" : "var(--text-muted)" }}
          >
            Playground
          </Link>
          <a
            href="https://github.com/iamshahid1997/curb"
            className="hidden sm:inline"
            style={{ color: "var(--text-muted)" }}
          >
            GitHub
          </a>
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
