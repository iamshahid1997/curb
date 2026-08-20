/**
 * A real `curb` run, transcribed verbatim.
 *
 * Every line below came out of an actual run against this repository's own dev
 * server. The route metrics, the axe counts, the source locations and the
 * shared-origin grouping are the tool's real output, and the run really did end
 * on a free-tier quota error partway through — so that is how the transcript
 * ends.
 *
 * What is deliberately NOT here: the patch, verification and findings sections.
 * A complete agent loop has not yet finished inside the free-tier budget of 20
 * requests per model per day, so showing one would be a fabrication. The
 * findings displayed elsewhere on the page come from a different run that did
 * complete, and are labelled as such.
 */

import type { TerminalLine } from "@/components/terminal";

export const RECORDED_RUN: TerminalLine[] = [
  { kind: "command", text: "npx curb --url http://localhost:3000", delay: 420 },
  { kind: "blank", text: "" },
  { kind: "dim", text: "curb · . · next-app", delay: 300 },
  { kind: "dim", text: "dry run — no files will be written", delay: 140 },
  { kind: "blank", text: "" },
  {
    kind: "dim",
    text: "http://localhost:3000 · 4 route(s): /, /dev/agent, /dev/boot, /dev/sandbox",
    delay: 360,
  },
  { kind: "blank", text: "" },

  { kind: "tool", text: "› probing /", delay: 320 },
  { kind: "route", text: "  /  ·  9 axe  ·  8 tab stops  ·  LCP 112ms  ·  CLS 0.058", delay: 540 },
  { kind: "blank", text: "" },
  { kind: "dim", text: "  element → the JSX that rendered it", delay: 240 },
  {
    kind: "success",
    text: "  src/components/primitives.tsx:107   ← 2 elements  (SHARED ORIGIN — one root cause)",
    delay: 240,
  },
  {
    kind: "success",
    text: "  src/app/page.tsx:295                ← 2 elements  (SHARED ORIGIN — one root cause)",
    delay: 130,
  },
  { kind: "output", text: "  src/app/page.tsx:317                ← textarea", delay: 110 },
  { kind: "output", text: "  src/components/primitives.tsx:136   ← button", delay: 110 },
  { kind: "dim", text: "  resolved 8 / 9", delay: 150 },
  { kind: "blank", text: "" },

  { kind: "tool", text: "  → read_file  src/components/primitives.tsx", delay: 320 },
  { kind: "tool", text: "  → visit_route  /dev/agent", delay: 300 },
  { kind: "tool", text: "› probing /dev/agent", delay: 220 },
  { kind: "route", text: "  /dev/agent  ·  2 axe  ·  2 tab stops  ·  LCP 68ms  ·  CLS 0", delay: 460 },
  { kind: "blank", text: "" },

  { kind: "tool", text: "  → visit_route  /dev/boot", delay: 260 },
  { kind: "tool", text: "› probing /dev/boot", delay: 200 },
  { kind: "route", text: "  /dev/boot  ·  9 axe  ·  5 tab stops  ·  LCP 80ms  ·  CLS 0.049", delay: 440 },
  { kind: "blank", text: "" },

  { kind: "tool", text: "  → visit_route  /dev/sandbox", delay: 260 },
  { kind: "tool", text: "› probing /dev/sandbox", delay: 200 },
  { kind: "route", text: "  /dev/sandbox  ·  2 axe  ·  9 tab stops  ·  LCP 68ms  ·  CLS 0", delay: 440 },
  { kind: "blank", text: "" },

  { kind: "warn", text: "curb failed: quota exceeded", delay: 520 },
  {
    kind: "dim",
    text: "  generate_content_free_tier_requests · limit: 20 · model: gemini-3.5-flash",
    delay: 180,
  },
  { kind: "blank", text: "" },
  {
    kind: "dim",
    text: "— transcript ends here because the run did. The free tier allows 20 requests",
    delay: 260,
  },
  { kind: "dim", text: "  per model per day, and a whole-page audit spends them quickly.", delay: 120 },
];

/**
 * Findings from a run that DID complete.
 *
 * These came from Curb in component mode against a deliberately broken card —
 * the mode that existed before the CLI. They are reproduced exactly, including
 * the patch verdict, and are labelled in the UI as coming from that mode rather
 * than from the CLI transcript above.
 */
export interface ShowcaseFinding {
  severity: "critical" | "serious" | "moderate" | "minor";
  kind: "a11y" | "perf" | "correlation";
  caughtByAxe: boolean;
  title: string;
  detail: string;
  impact: string;
  evidence: string;
}

export const SHOWCASE_FINDINGS: ShowcaseFinding[] = [
  {
    severity: "critical",
    kind: "a11y",
    caughtByAxe: false,
    title: "Interactive div is unreachable by keyboard",
    detail:
      'The "Open details" control is a <div> with an onClick handler rather than a button, so it never receives focus.',
    impact: "Keyboard-only users cannot open the details panel at all.",
    evidence:
      "<div> has an onClick handler but is not focusable and has no keyboard handler — it is mouse-only",
  },
  {
    severity: "serious",
    kind: "correlation",
    caughtByAxe: false,
    title: "Memoised component silences its live region",
    detail:
      "The component is wrapped in React.memo while containing an aria-live region for status updates. When memoisation prevents the subtree re-rendering, the DOM never mutates and nothing is announced.",
    impact: "Status updates are silently lost for screen-reader users.",
    evidence: "Runtime: 1 state transition produced no live-region announcement (dialog open)",
  },
  {
    severity: "moderate",
    kind: "a11y",
    caughtByAxe: false,
    title: "Input labelled only by a placeholder",
    detail:
      'The field relies on placeholder="Field 2" with no associated <label> or aria-label — and "Field 2" describes nothing.',
    impact: "Screen-reader users get no indication of what the field is for.",
    evidence: '"Field 2" looks auto-generated rather than descriptive',
  },
  {
    severity: "minor",
    kind: "a11y",
    caughtByAxe: false,
    title: "Meaningless alt text",
    detail: 'The image uses alt="image1", which satisfies every rule engine and communicates nothing.',
    impact: "Screen-reader users hear a placeholder instead of a description.",
    evidence: '"image1" looks auto-generated rather than descriptive',
  },
];

/** The verified outcome of that same run. */
export const SHOWCASE_VERIFICATION = {
  accepted: true,
  deltas: [
    { label: "axe violations", before: 3, after: 1 },
    { label: "flagged names", before: 3, after: 0 },
    { label: "unreachable controls", before: 1, after: 0 },
    { label: "positive tabindex", before: 1, after: 0 },
  ],
  residual: 'Still open in state "dialog open": 1 axe violation.',
};
