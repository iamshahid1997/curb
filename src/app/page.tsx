"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { downloadCassette, replayRun } from "@/lib/agent/replay";
import { runAudit } from "@/lib/agent/run";
import type { Finding, RunRecord, TraceEvent, VerificationResult } from "@/lib/agent/types";
import { DEFAULT_FIXTURE, FIXTURES } from "@/lib/fixtures";
import { SandboxController } from "@/lib/sandbox-host";
import { waitForVisible } from "@/lib/visibility";
import type {
  FocusOrderResult,
  MeasuredBox,
  TranscriptResult,
} from "@/sandbox/protocol";

import {
  DiffPanel,
  FindingsList,
  FocusPanel,
  TracePanel,
  TranscriptPanel,
} from "@/components/panels";
import { SandboxPreview, type Overlay } from "@/components/preview";
import { Button, Empty, Panel, Tabs, Tag } from "@/components/primitives";

type ViewTab = "preview" | "transcript" | "focus" | "diff";

export default function Home() {
  const controllerRef = useRef<SandboxController | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [source, setSource] = useState(DEFAULT_FIXTURE.source);
  const [tab, setTab] = useState<ViewTab>("preview");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);

  const [transcript, setTranscript] = useState<TranscriptResult | null>(null);
  const [focus, setFocus] = useState<FocusOrderResult | null>(null);
  const [boxes, setBoxes] = useState<MeasuredBox[]>([]);
  const [showOverlays, setShowOverlays] = useState(true);
  const [replaying, setReplaying] = useState(false);

  /* ---------------------------------------------------------------------- */
  /* Sandbox lifecycle                                                      */
  /* ---------------------------------------------------------------------- */

  const refreshPanels = useCallback(async (src: string) => {
    const controller = controllerRef.current;
    if (!controller) return;

    try {
      // First paint can happen while the tab is still hidden, and probing a
      // document with no layout would surface the guard as an error the user
      // did nothing to cause.
      await waitForVisible();
      await controller.send<"mount">({ type: "mount", source: src });
      const [nextTranscript, nextFocus] = await Promise.all([
        controller.send<"transcribe_screen_reader">({ type: "transcribe_screen_reader" }),
        controller.send<"trace_focus_order">({ type: "trace_focus_order" }),
      ]);

      setTranscript(nextTranscript);
      setFocus(nextFocus);

      const selectors = [
        ...nextFocus.stops.map((s) => s.selector),
        ...nextFocus.unreachable.map((u) => u.selector),
      ].filter((s): s is string => Boolean(s));

      if (selectors.length) {
        const measured = await controller.send<"measure_boxes">({
          type: "measure_boxes",
          selectors,
        });
        setBoxes(measured.boxes);
      } else {
        setBoxes([]);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (controllerRef.current) return;
    controllerRef.current = new SandboxController({
      parent: frameHostRef.current ?? undefined,
    });
    void refreshPanels(DEFAULT_FIXTURE.source);

    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [refreshPanels]);

  /* ---------------------------------------------------------------------- */
  /* Run                                                                    */
  /* ---------------------------------------------------------------------- */

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    setEvents([]);
    setFindings([]);
    setRecord(null);
    setVerification(null);
    setStatus("Audit started.");
    setTab("preview");

    abortRef.current = new AbortController();

    try {
      const result = await runAudit({
        controller: controllerRef.current!,
        source,
        signal: abortRef.current.signal,
        onEvent: (event) => {
          setEvents((prev) => [...prev, event]);
          if (event.type === "findings") setFindings(event.findings);
          if (event.type === "patch-attempt") setVerification(event.verification);
          if (event.type === "phase") setStatus(`${event.phase}${event.note ? `: ${event.note}` : ""}`);
        },
      });

      setRecord(result);
      // Handy for saving a cassette, and for inspecting a run from the console.
      (window as unknown as { __curbRecord?: RunRecord }).__curbRecord = result;
      setStatus(
        `Audit complete. ${result.findings.length} findings, ` +
          `${result.findings.filter((f) => !f.caughtByAxe).length} that a rule engine missed.`,
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

  /* ---------------------------------------------------------------------- */
  /* Replay                                                                 */
  /* ---------------------------------------------------------------------- */

  const startReplay = useCallback(async () => {
    setReplaying(true);
    setError(null);
    setEvents([]);
    setFindings([]);
    setRecord(null);
    setVerification(null);
    setTab("preview");
    setStatus("Replaying a recorded run. No model calls are made.");

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/cassettes/ticket-card.json");
      if (!res.ok) throw new Error("Recorded run is unavailable.");
      const cassette = (await res.json()) as RunRecord;

      setSource(cassette.originalSource);
      await refreshPanels(cassette.originalSource);

      await replayRun({
        record: cassette,
        signal: abortRef.current.signal,
        onEvent: (event) => {
          setEvents((prev) => [...prev, event]);
          if (event.type === "findings") setFindings(event.findings);
          if (event.type === "patch-attempt") setVerification(event.verification);
          if (event.type === "phase") setStatus(`${event.phase}${event.note ? `: ${event.note}` : ""}`);
        },
      });

      setRecord(cassette);
      if (cassette.patchedSource) {
        await refreshPanels(cassette.patchedSource);
        setTab("diff");
      }
      setStatus(`Replay finished. ${cassette.findings.length} findings.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("cancelled")) setError(message);
    } finally {
      setReplaying(false);
    }
  }, [refreshPanels]);

  const busy = running || replaying;

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
        .map((u) => ({
          selector: u.selector!,
          kind: "unreachable" as const,
          label: "unreachable",
        })),
    ];
  }, [focus]);

  const missedByAxe = findings.filter((f) => !f.caughtByAxe).length;
  const correlations = findings.filter((f) => f.kind === "correlation").length;

  return (
    <div className="mx-auto min-h-dvh max-w-[1500px] px-4 py-5">
      {/* Announcements for assistive tech — this tool would flag their absence. */}
      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Curb</h1>
          <p className="mt-0.5 max-w-[62ch] text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            An agent that drives a React component through its real interaction states, judges
            what a rule engine cannot, and ships a patch it has verified. Every fix is
            re-measured before you see it.
          </p>
        </div>

        <div className="flex items-center gap-2">
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
      </header>

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-[var(--radius)] border px-3 py-2 text-[13px]"
          style={{
            borderColor: "var(--critical)",
            background: "var(--critical-bg)",
            color: "var(--critical)",
          }}
        >
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)_minmax(300px,380px)]">
        {/* ---------------------------------------------------------------- */}
        {/* Source                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex flex-col gap-4">
          <Panel
            title="Component"
            action={
              <div className="flex gap-1">
                {FIXTURES.map((fixture) => (
                  <button
                    key={fixture.id}
                    onClick={() => {
                      setSource(fixture.source);
                      void refreshPanels(fixture.source);
                    }}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      background: source === fixture.source ? "var(--accent)" : "transparent",
                      color: source === fixture.source ? "var(--accent-text)" : "var(--text-muted)",
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
              className="h-[420px] w-full resize-none p-3 text-[11.5px] leading-[1.6] outline-none"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--code-bg)",
                color: "var(--text)",
              }}
            />
          </Panel>

          <Panel title={`Trace${record ? ` · ${record.modelCalls} model calls` : ""}`}>
            <div className="max-h-[260px] overflow-y-auto">
              <TracePanel events={events} />
            </div>
          </Panel>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Preview / panels                                                 */}
        {/* ---------------------------------------------------------------- */}
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
              <label className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
                <input
                  type="checkbox"
                  checked={showOverlays}
                  onChange={(e) => setShowOverlays(e.target.checked)}
                />
                Tab order overlay
              </label>
            ) : null
          }
        >
          <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {/*
              The sandbox is rendered exactly once and never unmounted. Two
              constraints force this: unmounting would tear down the iframe and
              lose the compiled component, and `hidden` / `display:none` would
              zero its layout — at which point our own focus probe correctly
              refuses to run. So when another tab is active it moves off-screen
              while keeping its box.
            */}
            <div
              className={tab === "preview" ? "" : "pointer-events-none absolute -left-[200vw] top-0 w-[880px]"}
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
                before={source}
                after={record?.patchedSource ?? null}
                verification={verification}
              />
            )}
          </div>
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {/* Findings                                                         */}
        {/* ---------------------------------------------------------------- */}
        <Panel
          title="Findings"
          action={
            findings.length > 0 ? (
              <div className="flex gap-1">
                {missedByAxe > 0 && (
                  <Tag fg="var(--ok)" bg="var(--ok-bg)">
                    {missedByAxe} axe missed
                  </Tag>
                )}
                {correlations > 0 && (
                  <Tag
                    fg="var(--correlation)"
                    bg="var(--correlation-bg)"
                    border="var(--correlation-border)"
                  >
                    {correlations} coupled
                  </Tag>
                )}
              </div>
            ) : null
          }
        >
          <div className="max-h-[700px] overflow-y-auto">
            {busy && !findings.length ? (
              <Empty>
                <span className="curb-live-dot">Auditing…</span>
              </Empty>
            ) : (
              <FindingsList findings={findings} />
            )}
          </div>
        </Panel>
      </div>

      <footer className="mt-6 text-[11px] leading-relaxed" style={{ color: "var(--text-faint)" }}>
        Verification runs entirely in your browser — axe-core, the accessibility tree and focus
        tracing cost nothing to re-run, which is what makes an unbounded verify-repair loop
        affordable. Only planning and patch authoring call a model. Automated checks cover roughly
        40% of WCAG; Curb reduces defects and does not certify conformance.
      </footer>
    </div>
  );
}
