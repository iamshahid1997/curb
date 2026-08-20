"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { downloadCassette, replayRun } from "@/lib/agent/replay";
import { runAudit } from "@/lib/agent/run";
import type { Finding, RunRecord, TraceEvent, VerificationResult } from "@/lib/agent/types";
import { DEFAULT_FIXTURE, FIXTURES } from "@/lib/fixtures";
import { SandboxController } from "@/lib/sandbox-host";
import { waitForVisible } from "@/lib/visibility";
import type { AxeResult, FocusOrderResult, MeasuredBox, TranscriptResult } from "@/sandbox/protocol";

import { DiffPanel, FindingsList, FocusPanel, TranscriptPanel } from "@/components/panels";
import { SandboxPreview, type Overlay } from "@/components/preview";
import { SiteHeader } from "@/components/site-header";
import { Button, Empty, Panel, Tabs, Tag } from "@/components/primitives";
import { TracePanel } from "@/components/panels";

type ViewTab = "preview" | "transcript" | "focus" | "diff";

export default function Playground() {
  const controllerRef = useRef<SandboxController | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [source, setSource] = useState(DEFAULT_FIXTURE.source);
  const [activeFixture, setActiveFixture] = useState(DEFAULT_FIXTURE.id);
  const [tab, setTab] = useState<ViewTab>("preview");
  const [running, setRunning] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  /* Sandbox                                                                */
  /* ---------------------------------------------------------------------- */

  const refreshPanels = useCallback(async (src: string) => {
    const controller = controllerRef.current;
    if (!controller) return;

    try {
      // First paint can happen while the tab is hidden, and probing a document
      // with no layout would surface the guard as an error the user did not cause.
      await waitForVisible();
      await controller.send<"mount">({ type: "mount", source: src });

      const [nextAxe, nextTranscript, nextFocus] = await Promise.all([
        controller.send<"run_axe">({ type: "run_axe" }),
        controller.send<"transcribe_screen_reader">({ type: "transcribe_screen_reader" }),
        controller.send<"trace_focus_order">({ type: "trace_focus_order" }),
      ]);

      setAxe(nextAxe);
      setTranscript(nextTranscript);
      setFocus(nextFocus);

      const selectors = [
        ...nextFocus.stops.map((s) => s.selector),
        ...nextFocus.unreachable.map((u) => u.selector),
      ].filter((s): s is string => Boolean(s));

      setBoxes(
        selectors.length
          ? (await controller.send<"measure_boxes">({ type: "measure_boxes", selectors })).boxes
          : [],
      );

      setError(null);
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
      setTab("preview");
      void refreshPanels(fixture.source);
    },
    [refreshPanels],
  );

  /* ---------------------------------------------------------------------- */
  /* Run                                                                    */
  /* ---------------------------------------------------------------------- */

  const resetRun = () => {
    setError(null);
    setEvents([]);
    setFindings([]);
    setRecord(null);
    setVerification(null);
    setTab("preview");
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
      if (result.patchedSource) setTab("diff");
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
      if (cassette.patchedSource) {
        await refreshPanels(cassette.patchedSource);
        setTab("diff");
      }
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
        .map((s) => ({ selector: s.selector!, kind: "focus" as const, order: s.order, label: s.name || s.role })),
      ...focus.unreachable
        .filter((u) => u.selector)
        .map((u) => ({ selector: u.selector!, kind: "unreachable" as const, label: "unreachable" })),
    ];
  }, [focus]);

  const axeCount = axe?.violations.reduce((n, v) => n + v.nodes.length, 0) ?? 0;
  const missedByAxe = findings.filter((f) => !f.caughtByAxe).length;
  const coupled = findings.filter((f) => f.kind === "correlation").length;
  const flaggedNames = transcript?.lines.filter((l) => l.issues.length).length ?? 0;

  return (
    <>
      <SiteHeader current="playground" />

      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      {/*
        w-full is load-bearing: <main> is a direct flex child of a column-flex
        body, and auto margins in the cross axis switch off flex stretching, so
        without it the page collapses to its content width instead of filling
        to max-width.
      */}
      <main className="mx-auto w-full max-w-[1400px] px-5 py-6">
        {/* ------------------------------------------------------------- */}
        {/* Intro                                                         */}
        {/* ------------------------------------------------------------- */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Playground</h1>
            <p
              className="curb-prose mt-1.5 max-w-[68ch] text-[13.5px] leading-[1.6]"
              style={{ color: "var(--text-muted)" }}
            >
              The same probes and the same agent the CLI runs, against a single pasted
              component instead of your whole app. Everything except the model call happens
              in this browser tab —{" "}
              <Link href="/" style={{ color: "var(--accent-ink)" }}>
                npx curb
              </Link>{" "}
              is the version that reads your routes and patches your files.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {record && !busy && (
              <Button variant="ghost" onClick={() => downloadCassette(record)}>
                Save run
              </Button>
            )}
            {busy ? (
              <Button variant="danger" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={startReplay}>
                  Watch a recorded run
                </Button>
                <Button onClick={start}>Run audit</Button>
              </>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* Score strip — the comparison, stated plainly                  */}
        {/* ------------------------------------------------------------- */}
        <div
          className="mb-5 grid gap-px overflow-hidden rounded-[var(--radius)] sm:grid-cols-4"
          style={{ background: "var(--border)", border: "1px solid var(--border)" }}
        >
          <Stat
            label="axe-core violations"
            value={axeCount}
            tone={axeCount === 0 ? "ok" : "warn"}
            hint={axeCount === 0 ? "a clean bill of health" : "mechanical failures"}
          />
          <Stat
            label="Curb findings"
            value={findings.length}
            tone={findings.length ? "accent" : "neutral"}
            hint={findings.length ? "after judging the evidence" : "run an audit"}
          />
          <Stat
            label="axe missed"
            value={missedByAxe}
            tone={missedByAxe ? "ok" : "neutral"}
            hint="semantic and interaction defects"
          />
          <Stat
            label="coupled a11y × perf"
            value={coupled}
            tone={coupled ? "correlation" : "neutral"}
            hint="reported by nothing else"
          />
        </div>

        {error && (
          <p
            role="alert"
            className="mb-5 rounded-[var(--radius)] border px-3.5 py-2.5 text-[13px] leading-[1.55]"
            style={{
              borderColor: "var(--critical)",
              background: "var(--critical-bg)",
              color: "var(--critical)",
            }}
          >
            {error}
          </p>
        )}

        {/* ------------------------------------------------------------- */}
        {/* Workspace                                                     */}
        {/* ------------------------------------------------------------- */}
        <div className="grid gap-5 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-5">
            <Panel
              title="Component"
              action={
                <div className="flex gap-1">
                  {FIXTURES.map((fixture) => (
                    <button
                      key={fixture.id}
                      onClick={() => pickFixture(fixture.id)}
                      aria-pressed={activeFixture === fixture.id}
                      className="rounded px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        background: activeFixture === fixture.id ? "var(--accent)" : "transparent",
                        color:
                          activeFixture === fixture.id ? "var(--accent-text)" : "var(--text-muted)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {fixture.name}
                    </button>
                  ))}
                </div>
              }
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
                className="h-[460px] w-full resize-none p-3.5 text-[12.5px] leading-[1.7] outline-none"
                style={{
                  fontFamily: "var(--font-mono)",
                  background: "var(--code-bg)",
                  color: "var(--text)",
                }}
              />
              <p
                className="border-t px-3.5 py-2 text-[11.5px]"
                style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
              >
                Paste your own. Unresolvable imports render as placeholders and are reported
                as such.
              </p>
            </Panel>

            <Panel
              title={
                <span>
                  Agent trace
                  {record && (
                    <span style={{ color: "var(--text-faint)" }}>
                      {" · "}
                      {record.modelCalls} model calls · {record.model}
                    </span>
                  )}
                </span>
              }
            >
              <div className="max-h-[300px] overflow-y-auto">
                {busy && !events.length ? (
                  <Empty>Starting…</Empty>
                ) : (
                  <TracePanel events={events} />
                )}
              </div>
            </Panel>
          </div>

          <div className="flex flex-col gap-5">
            <Panel
              title={
                <Tabs
                  label="Component views"
                  active={tab}
                  onChange={setTab}
                  tabs={[
                    { id: "preview", label: "Preview" },
                    { id: "transcript", label: "Screen reader", count: transcript?.lines.length },
                    { id: "focus", label: "Keyboard", count: focus?.stops.length },
                    { id: "diff", label: "Patch" },
                  ]}
                />
              }
              action={
                tab === "preview" ? (
                  <label
                    className="flex items-center gap-1.5 text-[11.5px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <input
                      type="checkbox"
                      checked={showOverlays}
                      onChange={(e) => setShowOverlays(e.target.checked)}
                    />
                    Tab-order overlay
                  </label>
                ) : null
              }
            >
              <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
                {/*
                  The sandbox mounts once and is never unmounted. Unmounting would
                  tear down the iframe and lose the compiled component, and
                  display:none would zero its layout — at which point our own focus
                  probe correctly refuses to run. So it moves off-screen instead.
                */}
                <div
                  className={
                    tab === "preview"
                      ? ""
                      : "pointer-events-none absolute -left-[200vw] top-0 w-[880px]"
                  }
                  aria-hidden={tab === "preview" ? undefined : true}
                >
                  <SandboxPreview
                    frameHostRef={frameHostRef}
                    overlays={overlays}
                    boxes={boxes}
                    showOverlays={showOverlays && tab === "preview"}
                  />
                </div>

                {tab === "transcript" && <TranscriptPanel transcript={transcript} />}
                {tab === "focus" && <FocusPanel focus={focus} />}
                {tab === "diff" && (
                  <DiffPanel
                    before={record?.originalSource ?? source}
                    after={record?.patchedSource ?? null}
                    verification={verification}
                  />
                )}
              </div>
            </Panel>

            <Panel
              title="Findings"
              action={
                findings.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {missedByAxe > 0 && (
                      <Tag fg="var(--ok)" bg="var(--ok-bg)">
                        {missedByAxe} axe missed
                      </Tag>
                    )}
                    {coupled > 0 && (
                      <Tag
                        fg="var(--correlation)"
                        bg="var(--correlation-bg)"
                        border="var(--correlation-border)"
                      >
                        {coupled} coupled
                      </Tag>
                    )}
                  </div>
                ) : null
              }
            >
              <div className="max-h-[620px] overflow-y-auto">
                {busy && !findings.length ? (
                  <Empty>
                    <span className="curb-live-dot">Auditing…</span>
                  </Empty>
                ) : findings.length ? (
                  <FindingsList findings={findings} />
                ) : (
                  <div className="px-4 py-10 text-center">
                    <p className="text-[13.5px]" style={{ color: "var(--text-muted)" }}>
                      {axeCount === 0
                        ? "axe-core reports no violations for this component."
                        : `axe-core reports ${axeCount} violation${axeCount === 1 ? "" : "s"}.`}
                      {flaggedNames > 0 && (
                        <>
                          {" "}
                          The transcript already flags {flaggedNames} name
                          {flaggedNames === 1 ? "" : "s"} as meaningless.
                        </>
                      )}
                    </p>
                    <p className="mt-2 text-[12.5px]" style={{ color: "var(--text-faint)" }}>
                      Run an audit to see what a rule engine cannot judge.
                    </p>
                  </div>
                )}
              </div>
            </Panel>
          </div>
        </div>

        <footer
          className="mt-8 border-t pt-6 text-[11.5px] leading-[1.65]"
          style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
        >
          Verification runs entirely in this browser — axe-core, the accessibility tree and
          focus tracing cost nothing to re-run, which is what makes an unbounded
          verify-repair loop affordable. Only planning and patch authoring call a model.
          Automated checks cover roughly 30–40% of WCAG; Curb reduces defects and does not
          certify conformance.
        </footer>
      </main>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat                                                                       */
/* -------------------------------------------------------------------------- */

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "ok" | "warn" | "accent" | "correlation" | "neutral";
}) {
  const colour =
    tone === "ok"
      ? "var(--ok)"
      : tone === "warn"
        ? "var(--serious)"
        : tone === "accent"
          ? "var(--accent-ink)"
          : tone === "correlation"
            ? "var(--correlation)"
            : "var(--text-faint)";

  return (
    <div className="px-4 py-3.5" style={{ background: "var(--bg-raised)" }}>
      <p
        className="text-[10.5px] font-semibold uppercase tracking-[0.09em]"
        style={{ color: "var(--text-faint)" }}
      >
        {label}
      </p>
      <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em]" style={{ color: colour }}>
        {value}
      </p>
      <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--text-faint)" }}>
        {hint}
      </p>
    </div>
  );
}
