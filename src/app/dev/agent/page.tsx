"use client";

/**
 * Development harness for the agent loop. Not the product UI — this exists to
 * watch a real run happen and see where it goes wrong.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { runAudit } from "@/lib/agent/run";
import { SandboxController } from "@/lib/sandbox-host";
import type { Finding, RunRecord, TraceEvent } from "@/lib/agent/types";

/**
 * Deliberately broken, and broken in ways that span both halves of the pitch:
 * plain a11y defects a rule engine misses, plus coupled a11y/perf patterns
 * (memo around a live region, an unmarked loading state, unguarded animation,
 * a barrel icon import, a lazy first image).
 */
const CURSED = `import { Bell, ChevronDown } from "lucide-react";

const TicketCard = React.memo(function TicketCard({ ticket }) {
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  return (
    <div className="card animate-pulse transition-all duration-300">
      <h3>Ticket</h3>
      <img src="/hero.png" alt="image1" loading="lazy" />

      <div onClick={() => setOpen(true)}>
        Open details <ChevronDown />
      </div>

      <button><Bell /></button>

      <a href="/terms" tabIndex={3}>Terms</a>
      <input placeholder="Field 2" />

      <div aria-live="polite">{ticket?.status}</div>

      {saving && <div>Saving…</div>}

      {open && (
        <div role="dialog">
          <h4>Details</h4>
          <p>Seat 14A, gate B7.</p>
          <button onClick={() => setSaving(true)}>Save</button>
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
});`;

export default function AgentDevPage() {
  const controllerRef = useRef<SandboxController | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [source, setSource] = useState(CURSED);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (controllerRef.current) return;
    controllerRef.current = new SandboxController({
      parent: frameHostRef.current ?? undefined,
    });
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    setEvents([]);
    setRecord(null);
    setError(null);
    setRunning(true);

    abortRef.current = new AbortController();

    try {
      const result = await runAudit({
        controller: controllerRef.current!,
        source,
        signal: abortRef.current.signal,
        onEvent: (event) => setEvents((prev) => [...prev, event]),
      });
      setRecord(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [source]);

  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <header className="mb-4 flex items-baseline gap-4">
        <h1 className="text-xl font-semibold">Agent loop harness</h1>
        <button
          onClick={running ? () => abortRef.current?.abort() : start}
          className={`rounded px-4 py-1.5 text-sm font-medium ${
            running ? "bg-red-700" : "bg-blue-600"
          }`}
        >
          {running ? "cancel" : "run audit"}
        </button>
        {record && (
          <span className="text-xs text-neutral-400">
            {record.modelCalls} model calls · {record.model} ·{" "}
            {record.finishedAt ? record.finishedAt - record.startedAt : 0}ms
          </span>
        )}
      </header>

      {error && (
        <p className="mb-4 rounded border border-red-900 bg-red-950/50 p-3 text-sm">{error}</p>
      )}

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <section className="space-y-3">
          <textarea
            aria-label="Component source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            className="h-80 w-full rounded border border-neutral-800 bg-neutral-900 p-3 font-mono text-[11px]"
          />
          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Sandbox</p>
            <div
              ref={frameHostRef}
              className="h-64 overflow-hidden rounded border border-neutral-800 bg-white"
            />
          </div>
        </section>

        <section className="space-y-4">
          {record?.findings.length ? <FindingsPanel findings={record.findings} /> : null}
          {record?.verification && (
            <div className="rounded border border-neutral-800 bg-neutral-900 p-3 text-xs">
              <p className="mb-1 font-semibold">
                Verification — {record.verification.accepted ? "ACCEPTED" : "REJECTED"}
              </p>
              <p className="text-neutral-400">{record.verification.summary}</p>
            </div>
          )}

          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Trace</p>
            <ol className="space-y-1">
              {events.map((event, i) => (
                <li key={i}>
                  <TraceRow event={event} />
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </main>
  );
}

function FindingsPanel({ findings }: { findings: Finding[] }) {
  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wide text-neutral-500">
        Findings ({findings.length}) · {findings.filter((f) => !f.caughtByAxe).length} missed by axe
      </p>
      {findings.map((f) => (
        <div key={f.id} className="rounded border border-neutral-800 bg-neutral-900 p-3 text-xs">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                f.kind === "correlation"
                  ? "bg-purple-900 text-purple-200"
                  : f.kind === "perf"
                    ? "bg-amber-900 text-amber-200"
                    : "bg-sky-900 text-sky-200"
              }`}
            >
              {f.kind}
            </span>
            <span className="text-[10px] uppercase text-neutral-500">{f.severity}</span>
            {!f.caughtByAxe && (
              <span className="rounded bg-emerald-900 px-1.5 py-0.5 text-[10px] text-emerald-200">
                axe missed this
              </span>
            )}
            <span className="font-semibold">{f.title}</span>
          </div>
          <p className="text-neutral-300">{f.detail}</p>
          <p className="mt-1 text-neutral-400">Impact: {f.impact}</p>
          {f.anchor && <p className="mt-1 font-mono text-neutral-500">{f.anchor}</p>}
          {f.evidence?.length ? (
            <ul className="mt-1 list-inside list-disc text-neutral-500">
              {f.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TraceRow({ event }: { event: TraceEvent }) {
  const base = "rounded border px-2 py-1 font-mono text-[11px]";

  switch (event.type) {
    case "phase":
      return (
        <div className={`${base} border-neutral-800 bg-neutral-900 text-neutral-400`}>
          ▸ {event.phase}
          {event.note ? ` — ${event.note}` : ""}
        </div>
      );
    case "tool-call":
      return (
        <div className={`${base} border-blue-900 bg-blue-950/40 text-blue-200`}>
          → {event.tool}({JSON.stringify(event.input).slice(0, 120)})
        </div>
      );
    case "tool-result":
      return (
        <div
          className={`${base} ${
            event.ok
              ? "border-neutral-800 bg-neutral-900 text-neutral-400"
              : "border-red-900 bg-red-950/40 text-red-300"
          }`}
        >
          ← {event.tool} · {event.ms}ms
          <pre className="mt-1 whitespace-pre-wrap text-neutral-500">
            {String(event.output).slice(0, 400)}
          </pre>
        </div>
      );
    case "model-response":
      return (
        <div className={`${base} border-neutral-700 bg-neutral-800/60 text-neutral-300`}>
          model step {event.step} · {event.ms}ms · {event.toolCalls} tool call(s)
          {event.text ? <p className="mt-1 whitespace-pre-wrap">{event.text.slice(0, 400)}</p> : null}
        </div>
      );
    case "patch-attempt":
      return (
        <div
          className={`${base} ${
            event.verification.accepted
              ? "border-emerald-800 bg-emerald-950/40 text-emerald-200"
              : "border-amber-800 bg-amber-950/40 text-amber-200"
          }`}
        >
          patch #{event.attempt} — {event.verification.accepted ? "ACCEPTED" : "REJECTED"}
          <p className="mt-1 whitespace-pre-wrap">{event.verification.summary}</p>
        </div>
      );
    case "run-failed":
      return (
        <div className={`${base} border-red-900 bg-red-950/50 text-red-300`}>
          failed — {event.error}
        </div>
      );
    case "run-finished":
      return (
        <div className={`${base} border-emerald-900 bg-emerald-950/40 text-emerald-200`}>
          finished in {event.ms}ms
        </div>
      );
    default:
      return (
        <div className={`${base} border-neutral-800 bg-neutral-900 text-neutral-500`}>
          {event.type}
        </div>
      );
  }
}
