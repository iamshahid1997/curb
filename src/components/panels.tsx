"use client";

import { diffLines, diffStats, toHunks } from "@/lib/diff";
import { Empty, SeverityBadge, Tag } from "./primitives";
import type { Finding, TraceEvent, VerificationResult } from "@/lib/agent/types";
import type { FocusOrderResult, TranscriptResult } from "@/sandbox/protocol";

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export function FindingsList({
  findings,
  onHover,
}: {
  findings: Finding[];
  onHover?: (selector: string | null) => void;
}) {
  if (!findings.length) {
    return <Empty>No findings yet. Run an audit to populate this.</Empty>;
  }

  return (
    <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
      {findings.map((finding) => {
        const correlation = finding.kind === "correlation";
        return (
          <li
            key={finding.id}
            className="px-3 py-3"
            style={correlation ? { background: "var(--correlation-bg)" } : undefined}
            onMouseEnter={() => onHover?.(finding.anchor)}
            onMouseLeave={() => onHover?.(null)}
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <SeverityBadge severity={finding.severity} />
              {correlation && (
                <Tag
                  fg="var(--correlation)"
                  bg="var(--correlation-bg)"
                  border="var(--correlation-border)"
                >
                  a11y × perf
                </Tag>
              )}
              {!finding.caughtByAxe && (
                <Tag fg="var(--ok)" bg="var(--ok-bg)">
                  axe missed this
                </Tag>
              )}
              {finding.rootCause && (
                <Tag>
                  {finding.rootCause.instanceCount}× from {finding.rootCause.origin}
                </Tag>
              )}
            </div>

            <h3 className="text-[13.5px] font-semibold leading-snug">{finding.title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              {finding.detail}
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              <span style={{ color: "var(--text-faint)" }}>Impact: </span>
              {finding.impact}
            </p>

            {finding.anchor && (
              <code
                className="mt-1.5 inline-block rounded px-1.5 py-0.5 text-[11px]"
                style={{ background: "var(--code-bg)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
              >
                {finding.anchor}
              </code>
            )}

            {finding.evidence?.length > 0 && (
              <details className="mt-2">
                <summary
                  className="cursor-pointer text-[11px] font-medium"
                  style={{ color: "var(--text-faint)" }}
                >
                  Evidence ({finding.evidence.length})
                </summary>
                <ul className="mt-1 space-y-1">
                  {finding.evidence.map((line, i) => (
                    <li
                      key={i}
                      className="rounded px-2 py-1 text-[11px] leading-relaxed"
                      style={{
                        background: "var(--code-bg)",
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Screen-reader transcript                                                   */
/* -------------------------------------------------------------------------- */

export function TranscriptPanel({ transcript }: { transcript: TranscriptResult | null }) {
  if (!transcript) return <Empty>Mount a component to hear what it announces.</Empty>;

  return (
    <div className="p-3">
      <ol className="space-y-1">
        {transcript.lines.map((line, i) => (
          <li
            key={i}
            className="rounded px-2.5 py-1.5 text-[12.5px] leading-relaxed"
            style={{
              background: line.issues.length ? "var(--critical-bg)" : "var(--bg-sunken)",
              color: line.issues.length ? "var(--critical)" : "var(--text)",
            }}
          >
            <span style={{ color: "var(--text-faint)" }}>{i + 1}. </span>
            &ldquo;{line.text}&rdquo;
            {line.issues.map((issue, j) => (
              <span key={j} className="mt-1 block text-[11px] font-medium">
                ↳ {issue}
              </span>
            ))}
          </li>
        ))}
      </ol>

      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-faint)" }}>
        {transcript.disclaimer}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Focus order                                                                */
/* -------------------------------------------------------------------------- */

export function FocusPanel({ focus }: { focus: FocusOrderResult | null }) {
  if (!focus) return <Empty>Mount a component to trace its keyboard path.</Empty>;

  return (
    <div className="space-y-3 p-3">
      {focus.stops.length > 0 ? (
        <ol className="space-y-1">
          {focus.stops.map((stop) => (
            <li
              key={stop.order}
              className="flex items-start gap-2 rounded px-2.5 py-1.5 text-[12.5px]"
              style={{ background: "var(--bg-sunken)" }}
            >
              <span
                className="mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                style={{ background: "var(--accent)", color: "var(--accent-text)" }}
              >
                {stop.order}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{stop.name || "(no accessible name)"}</span>
                <span style={{ color: "var(--text-faint)" }}> · {stop.role}</span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {stop.tabindex !== null && stop.tabindex > 0 && (
                    <Tag fg="var(--serious)" bg="var(--serious-bg)">
                      tabindex={stop.tabindex}
                    </Tag>
                  )}
                  {stop.ariaHidden && (
                    <Tag fg="var(--critical)" bg="var(--critical-bg)">
                      inside aria-hidden
                    </Tag>
                  )}
                  {stop.focusIndicator === "suppressed" && (
                    <Tag fg="var(--critical)" bg="var(--critical-bg)">
                      no focus ring
                    </Tag>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>Nothing focusable.</Empty>
      )}

      {focus.unreachable.length > 0 && (
        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--serious)" }}>
            Never reached by Tab
          </h3>
          <ul className="space-y-1">
            {focus.unreachable.map((item, i) => (
              <li
                key={i}
                className="rounded px-2.5 py-1.5 text-[12px]"
                style={{ background: "var(--serious-bg)", color: "var(--serious)" }}
              >
                <span className="font-medium">{item.name || item.tag}</span> — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {focus.notes.length > 0 && (
        <ul className="space-y-1">
          {focus.notes.map((note, i) => (
            <li key={i} className="text-[11.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              • {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

export function DiffPanel({
  before,
  after,
  verification,
}: {
  before: string;
  after: string | null;
  verification: VerificationResult | null;
}) {
  if (!after) {
    return <Empty>No patch yet. The agent writes one once it has diagnosed the component.</Empty>;
  }

  const lines = diffLines(before, after);
  const hunks = toHunks(lines);
  const stats = diffStats(lines);

  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-[12px]"
        style={{ borderColor: "var(--border)" }}
      >
        <span style={{ color: "var(--ok)" }}>+{stats.added}</span>
        <span style={{ color: "var(--critical)" }}>−{stats.removed}</span>
        {verification && (
          <Tag
            fg={verification.accepted ? "var(--ok)" : "var(--critical)"}
            bg={verification.accepted ? "var(--ok-bg)" : "var(--critical-bg)"}
          >
            {verification.accepted ? "verified" : "rejected"}
          </Tag>
        )}
        {verification?.fixed.map((f, i) => (
          <Tag key={i} fg="var(--ok)" bg="var(--ok-bg)">
            {f}
          </Tag>
        ))}
        {verification?.regressed.map((r, i) => (
          <Tag key={i} fg="var(--critical)" bg="var(--critical-bg)">
            {r}
          </Tag>
        ))}
      </div>

      <div className="overflow-x-auto">
        <pre
          className="min-w-full text-[11.5px] leading-[1.6]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {hunks.map((hunk, hi) => (
            <div key={hi}>
              {hi > 0 && (
                <div className="px-3 py-1" style={{ color: "var(--text-faint)", background: "var(--bg-sunken)" }}>
                  ⋯
                </div>
              )}
              {hunk.lines.map((line, li) => (
                <div
                  key={li}
                  className="whitespace-pre px-3"
                  style={{
                    background:
                      line.kind === "added"
                        ? "var(--ok-bg)"
                        : line.kind === "removed"
                          ? "var(--critical-bg)"
                          : "transparent",
                    color:
                      line.kind === "added"
                        ? "var(--ok)"
                        : line.kind === "removed"
                          ? "var(--critical)"
                          : "var(--text-muted)",
                  }}
                >
                  <span className="select-none" style={{ color: "var(--text-faint)" }}>
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}{" "}
                  </span>
                  {line.text || " "}
                </div>
              ))}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Trace                                                                      */
/* -------------------------------------------------------------------------- */

export function TracePanel({ events }: { events: TraceEvent[] }) {
  if (!events.length) return <Empty>The agent&apos;s reasoning appears here as it works.</Empty>;

  return (
    <ol className="divide-y" style={{ borderColor: "var(--border)" }}>
      {events.map((event, i) => (
        <li key={i} className="px-3 py-1.5 text-[11.5px]" style={{ fontFamily: "var(--font-mono)" }}>
          <TraceRow event={event} />
        </li>
      ))}
    </ol>
  );
}

function TraceRow({ event }: { event: TraceEvent }) {
  switch (event.type) {
    case "phase":
      return (
        <span style={{ color: "var(--accent)" }}>
          ▸ {event.phase}
          {event.note ? ` — ${event.note}` : ""}
        </span>
      );
    case "tool-call":
      return (
        <span style={{ color: "var(--text)" }}>
          → {event.tool}
          <span style={{ color: "var(--text-faint)" }}>
            {" "}
            {JSON.stringify(event.input).slice(0, 90)}
          </span>
        </span>
      );
    case "tool-result":
      return (
        <span style={{ color: event.ok ? "var(--text-muted)" : "var(--critical)" }}>
          ← {event.tool} · {event.ms}ms
        </span>
      );
    case "model-response":
      return (
        <span style={{ color: "var(--text-muted)" }}>
          model step {event.step} · {event.ms}ms · {event.toolCalls} tool call
          {event.toolCalls === 1 ? "" : "s"}
        </span>
      );
    case "patch-attempt":
      return (
        <span style={{ color: event.verification.accepted ? "var(--ok)" : "var(--serious)" }}>
          patch #{event.attempt} — {event.verification.accepted ? "verified" : "rejected"}
          <span className="block whitespace-pre-wrap" style={{ color: "var(--text-muted)" }}>
            {event.verification.summary}
          </span>
        </span>
      );
    case "run-failed":
      return <span style={{ color: "var(--critical)" }}>failed — {event.error}</span>;
    case "run-finished":
      return <span style={{ color: "var(--ok)" }}>finished in {(event.ms / 1000).toFixed(1)}s</span>;
    case "run-started":
      return <span style={{ color: "var(--text-faint)" }}>run started</span>;
    default:
      return <span style={{ color: "var(--text-faint)" }}>{event.type}</span>;
  }
}
