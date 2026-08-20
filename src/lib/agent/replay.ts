/**
 * Cassette replay.
 *
 * A recorded run is the whole trace plus the sources, so replaying it needs no
 * model calls at all — which is what makes a public demo affordable. The free
 * tier turns out to be 20 requests per model per day, roughly two live audits,
 * so replay is the default path for a visitor rather than a fallback.
 *
 * Replay is honest about what it is: it re-emits recorded events, it does not
 * re-run the agent. The UI labels it.
 */

import type { RunRecord, TraceEvent } from "./types";

export interface ReplayOptions {
  record: RunRecord;
  onEvent: (event: TraceEvent) => void;
  signal?: AbortSignal;
  /**
   * Multiplier on the original inter-event delays. Real runs take ~60s, which
   * is too long to watch; 0.25 keeps the rhythm while fitting in a demo.
   */
  speed?: number;
  /** Never wait longer than this between events, whatever the recording says. */
  maxGapMs?: number;
}

export async function replayRun({
  record,
  onEvent,
  signal,
  speed = 0.25,
  maxGapMs = 1200,
}: ReplayOptions): Promise<void> {
  const events = record.events;
  if (!events.length) return;

  let previous = events[0].at;

  for (const event of events) {
    if (signal?.aborted) throw new Error("Replay cancelled.");

    const gap = Math.min(Math.max(0, (event.at - previous) * speed), maxGapMs);
    previous = event.at;

    if (gap > 0) await sleep(gap, signal);
    onEvent(event);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Replay cancelled."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Strip a record down to what replay needs.
 *
 * Tool outputs dominate the size — full axe payloads and transcripts — and the
 * trace UI only ever shows the first few hundred characters, so they are
 * truncated rather than shipped whole.
 */
export function toCassette(record: RunRecord): RunRecord {
  return {
    ...record,
    events: record.events.map((event) =>
      event.type === "tool-result"
        ? { ...event, output: String(event.output).slice(0, 600) }
        : event,
    ),
  };
}

export function downloadCassette(record: RunRecord): void {
  const blob = new Blob([JSON.stringify(toCassette(record), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${record.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
