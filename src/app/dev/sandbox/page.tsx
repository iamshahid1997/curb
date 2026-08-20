"use client";

/**
 * Development smoke test for the sandbox pipe.
 *
 * Not part of the product surface — this exists to prove mount / drive / axe /
 * watchdog behave against a real browser before anything is built on top.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SandboxController } from "@/lib/sandbox-host";
import type { AxeResult, DriveResult, MountResult } from "@/sandbox/protocol";

const SAMPLE = `function Card() {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <h3>Ticket</h3>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="image1" />
      <div onClick={() => setOpen(true)}>Open details</div>
      <a href="#x" tabIndex={3}>Terms</a>
      <input placeholder="Field 2" />
      <button aria-hidden="true">Hidden but tabbable</button>
      {open && (
        <div role="dialog">
          <p>Details go here.</p>
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}`;

const HOSTILE = `function Boom() {
  while (true) {}
  return <div>never</div>;
}`;

type LogEntry = { at: number; label: string; body: string; tone: "ok" | "err" | "info" };

export default function SandboxDevPage() {
  const controllerRef = useRef<SandboxController | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const [source, setSource] = useState(SAMPLE);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const push = useCallback((label: string, body: unknown, tone: LogEntry["tone"]) => {
    setLog((prev) => [
      { at: Date.now(), label, body: typeof body === "string" ? body : JSON.stringify(body, null, 2), tone },
      ...prev,
    ]);
  }, []);

  useEffect(() => {
    // StrictMode runs effects twice in dev. Without this guard we build two
    // sandboxes, each evaluating the full runtime, which is enough to stall the
    // renderer.
    if (controllerRef.current) return;

    const controller = new SandboxController({
      parent: frameHostRef.current ?? undefined,
      onRestart: (reason) => push("sandbox restarted", reason, "info"),
    });
    controllerRef.current = controller;

    const off = controller.onEvent((event) => {
      if (event.type === "runtime-error") push("runtime-error", event.error, "err");
    });

    return () => {
      off();
      controller.destroy();
      controllerRef.current = null;
    };
  }, [push]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      const started = performance.now();
      try {
        const result = await fn();
        push(`${label} · ${Math.round(performance.now() - started)}ms`, result, "ok");
      } catch (err) {
        const e = err as Error;
        push(`${label} · ${Math.round(performance.now() - started)}ms`, `${e.name}: ${e.message}`, "err");
      } finally {
        setBusy(false);
      }
    },
    [push],
  );

  const c = () => controllerRef.current!;

  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <h1 className="mb-1 text-xl font-semibold">Sandbox smoke test</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Opaque-origin iframe · protocol round trip · watchdog recovery
      </p>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section className="space-y-3">
          <textarea
            aria-label="Component source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            className="h-64 w-full rounded border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs"
          />

          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy}
              onClick={() => run("mount", () => c().send<"mount">({ type: "mount", source }))}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              mount
            </button>
            <button
              disabled={busy}
              onClick={() => run("run_axe", () => c().send<"run_axe">({ type: "run_axe" }))}
              className="rounded bg-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              run_axe
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run("drive: open dialog", () =>
                  c().send<"drive">({
                    type: "drive",
                    actions: [{ kind: "click", selector: "div > div" }],
                  }),
                )
              }
              className="rounded bg-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              drive
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run("trace_focus_order", () =>
                  c().send<"trace_focus_order">({ type: "trace_focus_order" }),
                )
              }
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              focus order
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run("transcribe_screen_reader", () =>
                  c().send<"transcribe_screen_reader">({ type: "transcribe_screen_reader" }),
                )
              }
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              transcript
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run("snapshot_a11y_tree", () =>
                  c().send<"snapshot_a11y_tree">({ type: "snapshot_a11y_tree" }),
                )
              }
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              a11y tree
            </button>
            <button
              disabled={busy}
              onClick={() => run("ping", () => c().send<"ping">({ type: "ping" }))}
              className="rounded bg-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              ping
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setSource(HOSTILE);
                void run("mount hostile (expect hang + restart)", () =>
                  c().send<"mount">({ type: "mount", source: HOSTILE }),
                );
              }}
              className="rounded bg-red-700 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              hang test
            </button>
          </div>

          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Sandbox frame</p>
            <div
              ref={frameHostRef}
              className="h-56 overflow-hidden rounded border border-neutral-800 bg-white"
            />
          </div>
        </section>

        <section>
          <p className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Log</p>
          <div className="max-h-[70vh] space-y-2 overflow-auto">
            {log.map((entry) => (
              <div
                key={entry.at + entry.label}
                className={`rounded border p-2 text-xs ${
                  entry.tone === "err"
                    ? "border-red-900 bg-red-950/40"
                    : entry.tone === "info"
                      ? "border-amber-900 bg-amber-950/30"
                      : "border-neutral-800 bg-neutral-900"
                }`}
              >
                <div className="mb-1 font-mono font-semibold">{entry.label}</div>
                <pre className="whitespace-pre-wrap break-all text-neutral-400">{entry.body}</pre>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

export type { AxeResult, DriveResult, MountResult };
