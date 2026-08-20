"use client";

/**
 * Replays a recorded terminal session.
 *
 * The lines are real output from a real `curb` run, not a mockup — which is the
 * only reason it is worth showing. Playback reveals lines on their recorded
 * cadence so the pacing matches what a run actually feels like.
 *
 * Under prefers-reduced-motion the whole transcript renders at once: an
 * animation that cannot be skipped is a barrier, and this component sits on the
 * landing page of an accessibility tool.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type LineKind =
  | "command"
  | "output"
  | "dim"
  | "route"
  | "tool"
  | "success"
  | "warn"
  | "heading"
  | "blank";

export interface TerminalLine {
  kind: LineKind;
  text: string;
  /** Milliseconds to wait before revealing this line. */
  delay?: number;
}

const KIND_STYLE: Record<LineKind, string> = {
  command: "var(--term-command)",
  output: "var(--term-text)",
  dim: "var(--term-dim)",
  route: "var(--term-route)",
  tool: "var(--term-tool)",
  success: "var(--term-success)",
  warn: "var(--term-warn)",
  heading: "var(--term-heading)",
  blank: "transparent",
};

export function Terminal({
  lines,
  title = "zsh",
  autoPlay = true,
  loop = false,
  className = "",
}: {
  lines: TerminalLine[];
  title?: string;
  autoPlay?: boolean;
  loop?: boolean;
  className?: string;
}) {
  const [visible, setVisible] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [reduced, setReduced] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReduced(query.matches);
      if (query.matches) setVisible(lines.length);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [lines.length]);

  // Only start once the terminal is actually on screen — autoplaying a
  // transcript nobody is looking at wastes the reveal.
  useEffect(() => {
    if (reduced || !autoPlay) return;
    const el = scrollRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !startedRef.current) {
          startedRef.current = true;
          setPlaying(true);
        }
      },
      { threshold: 0.25 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [autoPlay, reduced]);

  useEffect(() => {
    if (!playing || reduced) return;
    if (visible >= lines.length) {
      if (!loop) return;
      const timer = setTimeout(() => setVisible(0), 3000);
      return () => clearTimeout(timer);
    }

    const delay = lines[visible]?.delay ?? 55;
    const timer = setTimeout(() => setVisible((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [playing, visible, lines, loop, reduced]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const skip = useCallback(() => setVisible(lines.length), [lines.length]);
  const done = visible >= lines.length;

  return (
    <div
      className={`overflow-hidden rounded-xl border ${className}`}
      style={{
        borderColor: "var(--term-border)",
        background: "var(--term-bg)",
        boxShadow: "0 24px 60px -24px rgb(0 0 0 / 0.45)",
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-3.5 py-2.5"
        style={{ borderColor: "var(--term-border)" }}
      >
        <span className="flex gap-1.5" aria-hidden="true">
          <i className="block h-[10px] w-[10px] rounded-full" style={{ background: "#ff5f57" }} />
          <i className="block h-[10px] w-[10px] rounded-full" style={{ background: "#febc2e" }} />
          <i className="block h-[10px] w-[10px] rounded-full" style={{ background: "#28c840" }} />
        </span>
        <span
          className="ml-1 text-[11px] font-medium tracking-wide"
          style={{ color: "var(--term-dim)" }}
        >
          {title}
        </span>

        {!done && !reduced && (
          <button
            onClick={skip}
            className="ml-auto rounded px-2 py-0.5 text-[11px] font-medium"
            style={{ color: "var(--term-dim)", border: "1px solid var(--term-border)" }}
          >
            Skip
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        className="max-h-[440px] overflow-x-auto overflow-y-auto px-4 py-3.5"
        style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.75 }}
      >
        {/*
          The transcript is a single live region rather than per-line updates:
          announcing every line as it appears would flood a screen reader with
          a hundred interruptions.
        */}
        {/* min-w-max so the longest line sets the scroll width rather than
            being reflowed — wrapped terminal output is unreadable. */}
        <div aria-live="polite" aria-atomic="false" className="min-w-max">
          {lines.slice(0, visible).map((line, i) => (
            <div
              key={i}
              className="whitespace-pre"
              style={{ color: KIND_STYLE[line.kind], minHeight: line.kind === "blank" ? "0.9em" : undefined }}
            >
              {line.kind === "command" ? (
                <>
                  <span style={{ color: "var(--term-prompt)" }}>$ </span>
                  {line.text}
                </>
              ) : (
                line.text || " "
              )}
            </div>
          ))}

          {!done && !reduced && (
            <span
              aria-hidden="true"
              className="inline-block h-[1.05em] w-[7px] translate-y-[2px] curb-cursor"
              style={{ background: "var(--term-prompt)" }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
