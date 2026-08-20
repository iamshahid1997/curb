"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { downloadCassette, replayRun } from "@/lib/agent/replay";
import { runAudit } from "@/lib/agent/run";
import type { Finding, RunRecord, TraceEvent, VerificationResult } from "@/lib/agent/types";
import { DEFAULT_FIXTURE, FIXTURES } from "@/lib/fixtures";
import { SandboxController } from "@/lib/sandbox-host";
import type { AxeResult, FocusOrderResult, MeasuredBox, TranscriptResult } from "@/sandbox/protocol";

import {
  DiffPanel,
  FindingsList,
  FocusPanel,
  TracePanel,
  TranscriptPanel,
} from "@/components/panels";
import { SandboxPreview, type Overlay } from "@/components/preview";
import { SiteHeader } from "@/components/site-header";

/**
 * The rendered component is the subject of this page and everything else is
 * supporting detail.
 *
 * The previous version was a grid of equal-weight panels — a debug layout, with
 * no focal point and a screen two-thirds empty. Leading with the preview also
 * removes a hack: when the preview was one tab among several, the sandbox had to
 * be parked off-screen on the other tabs to keep its layout alive, because
 * unmounting loses the compiled component and display:none zeroes the geometry
 * our own focus probe depends on. It is always visible now, so none of that is
 * needed.
 */

type RailTab = "findings" | "transcript" | "focus" | "patch" | "trace";

const RAIL_TABS: Array<{ id: RailTab; label: string }> = [
  { id: "findings", label: "Findings" },
  { id: "transcript", label: "Screen reader" },
  { id: "focus", label: "Keyboard" },
  { id: "patch", label: "Patch" },
  { id: "trace", label: "Trace" },
];

/** Defects are frequently width-dependent, so the stage resizes. */
const WIDTHS = [
  { id: "narrow", label: "375", width: 375 },
  { id: "tablet", label: "768", width: 768 },
  { id: "full", label: "Fill", width: 0 },
] as const;

export default function Playground() {
  const controllerRef = useRef<SandboxController | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [source, setSource] = useState(DEFAULT_FIXTURE.source);
  const [activeFixture, setActiveFixture] = useState(DEFAULT_FIXTURE.id);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [rail, setRail] = useState<RailTab>("findings");
  const [stageWidth, setStageWidth] = useState<(typeof WIDTHS)[number]["id"]>("full");

  const [running, setRunning] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);

  const [axe, setAxe] = useState<AxeResult | null>(null);
  const [transcript, setTranscript] = useState<TranscriptResult | null>(null);
  const [focus, setFocus] = useState<FocusOrderResult | null>(null);
  const [boxes, setBoxes] = useState<MeasuredBox[]>([]);
  const [showOverlays, setShowOverlays] = useState(true);

  const busy = running || replaying;

  /* ---------------------------------------------------------------------- */
  /* Probing                                                                */
  /* ---------------------------------------------------------------------- */

  const refreshPanels = useCallback(async (src: string) => {
    const controller = controllerRef.current;
    if (!controller) return;

    try {
      // Deliberately not gated on visibility. Only geometry-dependent probes
      // need a painted frame, and blocking the mount on it meant that any
      // context reporting itself permanently hidden — an embedded view, a tab
      // never brought to the foreground — showed "waiting" forever and never
      // rendered anything. Mount, axe and the transcript work regardless.
      await controller.send<"mount">({ type: "mount", source: src });

      const [nextAxe, nextTranscript] = await Promise.all([
        controller.send<"run_axe">({ type: "run_axe" }),
        controller.send<"transcribe_screen_reader">({ type: "transcribe_screen_reader" }),
      ]);

      setAxe(nextAxe);
      setTranscript(nextTranscript);
      setError(null);

      // The focus tracer is the one probe that refuses to run without layout,
      // because a frame with no layout reports every control as unreachable.
      // Degrade to "not measured" rather than blocking everything else.
      try {
        const nextFocus = await controller.send<"trace_focus_order">({
          type: "trace_focus_order",
        });
        setFocus(nextFocus);
        setNotice(null);

        const selectors = [
          ...nextFocus.stops.map((x) => x.selector),
          ...nextFocus.unreachable.map((u) => u.selector),
        ].filter((x): x is string => Boolean(x));

        setBoxes(
          selectors.length
            ? (await controller.send<"measure_boxes">({ type: "measure_boxes", selectors })).boxes
            : [],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/no layout|hidden|background/i.test(message)) {
          setFocus(null);
          setBoxes([]);
          setNotice("Keyboard checks need a visible tab — bring this page to the foreground.");
        } else {
          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (controllerRef.current) return;
    controllerRef.current = new SandboxController({ parent: frameHostRef.current ?? undefined });
    void refreshPanels(DEFAULT_FIXTURE.source);
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [refreshPanels]);

  // Overlay boxes are in sandbox coordinates, so resizing the stage or opening
  // the drawer invalidates them. Re-measure once the layout has settled.
  useEffect(() => {
    const id = setTimeout(() => void refreshPanels(source), 240);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageWidth, sourceOpen]);

  const pickFixture = useCallback(
    (id: string) => {
      const fixture = FIXTURES.find((f) => f.id === id);
      if (!fixture) return;
      setActiveFixture(id);
      setSource(fixture.source);
      setFindings([]);
      setRecord(null);
      setVerification(null);
      setEvents([]);
      setRail("findings");
      void refreshPanels(fixture.source);
    },
    [refreshPanels],
  );

  /* ---------------------------------------------------------------------- */
  /* Runs                                                                   */
  /* ---------------------------------------------------------------------- */

  const resetRun = () => {
    setError(null);
    setEvents([]);
    setFindings([]);
    setRecord(null);
    setVerification(null);
  };

  const onEvent = (event: TraceEvent) => {
    setEvents((prev) => [...prev, event]);
    if (event.type === "findings") setFindings(event.findings);
    if (event.type === "patch-attempt") setVerification(event.verification);
    if (event.type === "phase") setStatus(`${event.phase}${event.note ? `: ${event.note}` : ""}`);
  };

  const start = useCallback(async () => {
    resetRun();
    setRunning(true);
    setRail("trace");
    setStatus("Audit started.");
    abortRef.current = new AbortController();

    try {
      const result = await runAudit({
        controller: controllerRef.current!,
        source,
        signal: abortRef.current.signal,
        onEvent,
      });

      setRecord(result);
      (window as unknown as { __curbRecord?: RunRecord }).__curbRecord = result;
      setStatus(
        `Audit complete. ${result.findings.length} findings, ` +
          `${result.findings.filter((f) => !f.caughtByAxe).length} a rule engine missed.`,
      );
      await refreshPanels(result.patchedSource ?? source);
      setRail(result.findings.length ? "findings" : "trace");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus(`Audit failed: ${message}`);
    } finally {
      setRunning(false);
    }
  }, [source, refreshPanels]);

  const startReplay = useCallback(async () => {
    resetRun();
    setReplaying(true);
    setRail("trace");
    setStatus("Replaying a recorded run. No model calls are made.");
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/cassettes/ticket-card.json");
      if (!res.ok) throw new Error("No recorded run is bundled yet.");
      const cassette = (await res.json()) as RunRecord;

      setSource(cassette.originalSource);
      await refreshPanels(cassette.originalSource);
      await replayRun({ record: cassette, signal: abortRef.current.signal, onEvent });

      setRecord(cassette);
      if (cassette.patchedSource) await refreshPanels(cassette.patchedSource);
      setRail("findings");
      setStatus(`Replay finished. ${cassette.findings.length} findings.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("cancelled")) setError(message);
    } finally {
      setReplaying(false);
    }
  }, [refreshPanels]);

  /* ---------------------------------------------------------------------- */
  /* Derived                                                                */
  /* ---------------------------------------------------------------------- */

  const overlays: Overlay[] = useMemo(() => {
    if (!focus) return [];
    return [
      ...focus.stops
        .filter((s) => s.selector)
        .map((s) => ({
          selector: s.selector!,
          kind: "focus" as const,
          order: s.order,
          label: s.name || s.role,
        })),
      ...focus.unreachable
        .filter((u) => u.selector)
        .map((u) => ({ selector: u.selector!, kind: "unreachable" as const, label: "unreachable" })),
    ];
  }, [focus]);

  const axeCount = axe?.violations.reduce((n, v) => n + v.nodes.length, 0) ?? 0;
  const missedByAxe = findings.filter((f) => !f.caughtByAxe).length;
  const coupled = findings.filter((f) => f.kind === "correlation").length;
  const flaggedNames = transcript?.lines.filter((l) => l.issues.length).length ?? 0;
  const stage = WIDTHS.find((w) => w.id === stageWidth)!;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <SiteHeader current="playground" />

      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      {/* ---------------------------------------------------------------- */}
      {/* Toolbar                                                          */}
      {/* ---------------------------------------------------------------- */}
      {/*
        A labelled region, not a bare div: axe's `region` rule requires every
        piece of content to sit inside a landmark, and a floating toolbar of
        controls is exactly the kind of thing screen-reader users cannot find
        by landmark navigation otherwise.
      */}
      <section
        aria-label="Audit controls"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5"
        style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
      >
        <button
          onClick={() => setSourceOpen((v) => !v)}
          aria-expanded={sourceOpen}
          className="rounded-md px-2.5 py-1.5 text-[12.5px] font-medium"
          style={{
            border: "1px solid var(--border-strong)",
            background: sourceOpen ? "var(--bg-sunken)" : "transparent",
            color: "var(--text)",
          }}
        >
          {sourceOpen ? "Hide source" : "Source"}
        </button>

        <div className="flex gap-1" role="group" aria-label="Example component">
          {FIXTURES.map((fixture) => (
            <button
              key={fixture.id}
              onClick={() => pickFixture(fixture.id)}
              aria-pressed={activeFixture === fixture.id}
              className="rounded-md px-2.5 py-1.5 text-[12.5px] font-medium"
              style={{
                border: "1px solid var(--border)",
                background: activeFixture === fixture.id ? "var(--bg-sunken)" : "transparent",
                color: activeFixture === fixture.id ? "var(--text)" : "var(--text-muted)",
              }}
            >
              {fixture.name}
            </button>
          ))}
        </div>

        <div
          className="flex gap-0.5 rounded-md p-0.5"
          role="group"
          aria-label="Stage width"
          style={{ border: "1px solid var(--border)" }}
        >
          {WIDTHS.map((w) => (
            <button
              key={w.id}
              onClick={() => setStageWidth(w.id)}
              aria-pressed={stageWidth === w.id}
              className="rounded px-2 py-1 text-[11.5px] font-medium"
              style={{
                background: stageWidth === w.id ? "var(--text)" : "transparent",
                color: stageWidth === w.id ? "var(--bg)" : "var(--text-muted)",
              }}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* Counts appear once there is something to count, never as zeroes. */}
        {(findings.length > 0 || axeCount > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <Chip label="axe" value={axeCount} tone={axeCount ? "warn" : "muted"} />
            {findings.length > 0 && <Chip label="Curb" value={findings.length} tone="accent" />}
            {missedByAxe > 0 && <Chip label="axe missed" value={missedByAxe} tone="ok" />}
            {coupled > 0 && <Chip label="a11y×perf" value={coupled} tone="correlation" />}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 text-[12px]"
            style={{ color: "var(--text-muted)" }}
          >
            <input
              type="checkbox"
              checked={showOverlays}
              onChange={(e) => setShowOverlays(e.target.checked)}
            />
            Overlays
          </label>

          {record && !busy && (
            <button
              onClick={() => downloadCassette(record)}
              className="rounded-md px-2.5 py-1.5 text-[12.5px] font-medium"
              style={{ border: "1px solid var(--border-strong)", color: "var(--text)" }}
            >
              Save run
            </button>
          )}

          {busy ? (
            <button
              onClick={() => abortRef.current?.abort()}
              className="rounded-md px-3 py-1.5 text-[12.5px] font-medium"
              style={{
                background: "var(--critical-bg)",
                color: "var(--critical)",
                border: "1px solid var(--border)",
              }}
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                onClick={startReplay}
                className="rounded-md px-2.5 py-1.5 text-[12.5px] font-medium"
                style={{ border: "1px solid var(--border-strong)", color: "var(--text)" }}
              >
                Recorded run
              </button>
              <button
                onClick={start}
                className="rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold"
                style={{ background: "var(--accent)", color: "var(--accent-text)" }}
              >
                Run audit
              </button>
            </>
          )}
        </div>
      </section>

      {error && (
        <p
          role="alert"
          aria-label="Error"
          className="shrink-0 border-b px-4 py-2 text-[12.5px]"
          style={{
            borderColor: "var(--border)",
            background: "var(--critical-bg)",
            color: "var(--critical)",
          }}
        >
          {error}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Body                                                             */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {sourceOpen && (
          <aside
            aria-label="Component source"
            className="flex min-h-0 w-full min-w-0 shrink-0 flex-col border-b lg:w-[420px] lg:border-b-0 lg:border-r"
            style={{ borderColor: "var(--border)" }}
          >
            <label htmlFor="source" className="sr-only">
              Component source
            </label>
            <textarea
              id="source"
              value={source}
              spellCheck={false}
              onChange={(e) => setSource(e.target.value)}
              onBlur={() => void refreshPanels(source)}
              className="min-h-[220px] w-full min-w-0 flex-1 resize-none p-4 text-[12.5px] leading-[1.7] outline-none"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--code-bg)",
                color: "var(--text)",
              }}
            />
            <p
              className="shrink-0 border-t px-4 py-2 text-[11.5px]"
              style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
            >
              Paste your own. Unresolvable imports render as placeholders and are reported as
              such.
            </p>
          </aside>
        )}

        {/* The stage */}
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          style={{ background: "var(--bg-sunken)" }}
        >
          <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4 sm:p-6">
            <div
              className="w-full overflow-hidden rounded-xl"
              style={{
                maxWidth: stage.width || undefined,
                border: "1px solid var(--border)",
                boxShadow: "0 18px 44px -22px rgb(0 0 0 / 0.35)",
                background: "#fff",
              }}
            >
              <SandboxPreview
                frameHostRef={frameHostRef}
                overlays={overlays}
                boxes={boxes}
                showOverlays={showOverlays}
              />
            </div>
          </div>

          <div
            className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-4 py-2 text-[11.5px]"
            style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
          >
            <span className="flex items-center gap-1.5">
              <i
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{ border: "2px solid var(--accent)" }}
              />
              tab stop
            </span>
            <span className="flex items-center gap-1.5">
              <i
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{ border: "2px solid var(--serious)" }}
              />
              unreachable by keyboard
            </span>
            {notice && <span style={{ color: "var(--text-muted)" }}>{notice}</span>}
            {busy && (
              <span className="curb-live-dot ml-auto" style={{ color: "var(--accent-ink)" }}>
                {status}
              </span>
            )}
          </div>
        </main>

        {/* The rail */}
        <aside
          aria-label="Audit detail"
          className="flex min-h-0 w-full min-w-0 shrink-0 flex-col border-t lg:w-[400px] lg:border-l lg:border-t-0"
          style={{ borderColor: "var(--border)", background: "var(--bg-raised)" }}
        >
          <div
            role="tablist"
            aria-label="Audit detail"
            className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-2"
            style={{ borderColor: "var(--border)" }}
          >
            {RAIL_TABS.map((t) => {
              const selected = rail === t.id;
              const count =
                t.id === "findings"
                  ? findings.length
                  : t.id === "transcript"
                    ? transcript?.lines.length
                    : t.id === "focus"
                      ? focus?.stops.length
                      : undefined;
              return (
                <button
                  key={t.id}
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls="rail-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setRail(t.id)}
                  onKeyDown={(e) => {
                    const i = RAIL_TABS.findIndex((x) => x.id === rail);
                    if (e.key === "ArrowRight") setRail(RAIL_TABS[(i + 1) % RAIL_TABS.length].id);
                    if (e.key === "ArrowLeft")
                      setRail(RAIL_TABS[(i - 1 + RAIL_TABS.length) % RAIL_TABS.length].id);
                  }}
                  className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium"
                  style={{
                    background: selected ? "var(--bg-sunken)" : "transparent",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    border: `1px solid ${selected ? "var(--border-strong)" : "transparent"}`,
                  }}
                >
                  {t.label}
                  {typeof count === "number" && count > 0 && (
                    <span style={{ color: "var(--text-faint)" }}> {count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div
            id="rail-panel"
            role="tabpanel"
            aria-labelledby={`tab-${rail}`}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {rail === "findings" &&
              (findings.length ? (
                <FindingsList findings={findings} />
              ) : (
                <IdleFindings
                  probed={axe !== null}
                  axeCount={axeCount}
                  flaggedNames={flaggedNames}
                  unreachable={focus ? focus.unreachable.length : null}
                  busy={busy}
                />
              ))}
            {rail === "transcript" && <TranscriptPanel transcript={transcript} />}
            {rail === "focus" && <FocusPanel focus={focus} />}
            {rail === "patch" && (
              <DiffPanel
                before={record?.originalSource ?? source}
                after={record?.patchedSource ?? null}
                verification={verification}
              />
            )}
            {rail === "trace" && <TracePanel events={events} />}
          </div>

          <p
            className="curb-prose shrink-0 border-t px-4 py-2.5 text-[11px] leading-[1.6]"
            style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
          >
            Probing runs in this tab and costs nothing.{" "}
            <Link href="/" style={{ color: "var(--accent-ink)" }}>
              npx curb
            </Link>{" "}
            audits your real routes and patches your files.
          </p>
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Bits                                                                       */
/* -------------------------------------------------------------------------- */

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "warn" | "accent" | "ok" | "correlation" | "muted";
}) {
  const map = {
    warn: { fg: "var(--serious)", bg: "var(--serious-bg)" },
    accent: { fg: "var(--accent-ink)", bg: "var(--bg-sunken)" },
    ok: { fg: "var(--ok)", bg: "var(--ok-bg)" },
    correlation: { fg: "var(--correlation)", bg: "var(--correlation-bg)" },
    muted: { fg: "var(--text-faint)", bg: "var(--bg-sunken)" },
  }[tone];

  return (
    <span className="rounded px-1.5 py-0.5 font-medium" style={{ color: map.fg, background: map.bg }}>
      {label} <strong>{value}</strong>
    </span>
  );
}

/**
 * The idle state reports what the oracle already knows rather than "no findings
 * yet" — every number here is measured before any model runs, which is the
 * argument the product is making.
 */
function IdleFindings({
  probed,
  axeCount,
  flaggedNames,
  unreachable,
  busy,
}: {
  probed: boolean;
  axeCount: number;
  flaggedNames: number;
  /** null when the focus tracer could not run, which is not the same as zero. */
  unreachable: number | null;
  busy: boolean;
}) {
  // "0 violations — a clean bill of health" before anything has been measured
  // is a confident false statement, and precisely the failure this tool exists
  // to argue against. Nothing is claimed until the probes have actually run.
  if (!probed && !busy) {
    return (
      <p className="px-4 py-10 text-center text-[13px] leading-[1.6]" style={{ color: "var(--text-faint)" }}>
        Waiting for the component to mount.
        <span className="mt-1 block text-[11.5px]">
          Probes need a painted frame, so this pauses while the tab is in the background.
        </span>
      </p>
    );
  }

  if (busy) {
    return (
      <p className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--text-faint)" }}>
        <span className="curb-live-dot">Auditing…</span>
      </p>
    );
  }

  return (
    <div className="px-4 py-6">
      <p className="text-[13px] leading-[1.65]" style={{ color: "var(--text-muted)" }}>
        Before the agent runs, the oracle already knows this much:
      </p>

      <ul className="mt-4 space-y-3.5">
        <IdleRow
          value={axeCount}
          label="axe-core violations"
          hint={axeCount ? "mechanical failures" : "a clean bill of health"}
          tone={axeCount ? "warn" : "ok"}
        />
        <IdleRow
          value={flaggedNames}
          label="names that mean nothing"
          hint="present, and useless — no rule engine reports these"
          tone={flaggedNames ? "accent" : "muted"}
        />
        <IdleRow
          value={unreachable}
          label="controls the keyboard never reaches"
          hint={
            unreachable === null
              ? "not measured — needs a visible tab"
              : "click handlers with no focus path"
          }
          tone={unreachable ? "accent" : "muted"}
        />
      </ul>

      <p className="mt-6 text-[12.5px] leading-[1.65]" style={{ color: "var(--text-faint)" }}>
        Run an audit to have the agent drive this component into its other states, judge what
        those names should be, and write a patch it verifies before showing you.
      </p>
    </div>
  );
}

function IdleRow({
  value,
  label,
  hint,
  tone,
}: {
  /** null renders an em dash — "not measured" must never read as zero. */
  value: number | null;
  label: string;
  hint: string;
  tone: "warn" | "accent" | "ok" | "muted";
}) {
  const fg = {
    warn: "var(--serious)",
    accent: "var(--accent-ink)",
    ok: "var(--ok)",
    muted: "var(--text-faint)",
  }[tone];

  return (
    <li className="flex items-baseline gap-3">
      <span
        className="w-8 shrink-0 text-right text-[22px] font-semibold leading-none tracking-[-0.02em]"
        style={{ color: value === null ? "var(--text-faint)" : fg }}
      >
        {value === null ? "—" : value}
      </span>
      <span className="min-w-0">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[11.5px] leading-[1.5]" style={{ color: "var(--text-faint)" }}>
          {hint}
        </span>
      </span>
    </li>
  );
}
