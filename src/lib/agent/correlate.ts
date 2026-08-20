/**
 * Coupled accessibility × performance rules.
 *
 * This is the part of Curb no other tool ships. Accessibility and performance
 * are audited as separate categories with separate scores, so the places where
 * a performance decision silently costs accessibility go unreported by both.
 *
 * These rules are deterministic and produce *candidates*, not findings. Each
 * carries the evidence that triggered it; the agent decides whether it matters
 * in context and writes it up. Keeping detection mechanical and judgement
 * modelled is the same split used everywhere else in this codebase — the model
 * is never the thing asserting a measurement.
 *
 * Two honest notes:
 *
 * - These rules were derived from known failure modes, not measured against a
 *   corpus. Their real-world frequency is unvalidated (PRD §8.4).
 * - The PRD listed "focus lost on state change" as a correlation. It is not —
 *   it is plain accessibility with no performance side. It has been dropped
 *   from this list rather than kept to inflate the count.
 */

import type {
  A11yTreeResult,
  DriveResult,
  FocusOrderResult,
  TranscriptResult,
} from "@/sandbox/protocol";
import type { SourceFacts } from "@/sandbox/runtime/probes/source";

export type Confidence = "observed" | "likely" | "possible";

export interface CorrelationCandidate {
  rule: string;
  title: string;
  /** The performance decision involved. */
  perfSide: string;
  /** The accessibility cost it incurs. */
  a11ySide: string;
  evidence: string[];
  confidence: Confidence;
  anchor: string | null;
}

export interface CorrelationInput {
  facts: SourceFacts;
  transcript: TranscriptResult | null;
  focus: FocusOrderResult | null;
  tree: A11yTreeResult | null;
  /** Drive transitions observed so far, for live-region checks. */
  transitions: Array<{ label: string; result: DriveResult }>;
}

export function detectCorrelations(input: CorrelationInput): CorrelationCandidate[] {
  const { facts, transcript, focus, tree, transitions } = input;
  const out: CorrelationCandidate[] = [];

  /* ---------------------------------------------------------------------- */
  /* C1 — memoisation silences a live region                                */
  /* ---------------------------------------------------------------------- */

  const memoedLive = facts.ariaLive.filter((r) => r.insideMemo);

  if (memoedLive.length > 0) {
    // Strongest form: a transition happened and nothing was announced.
    const silentTransitions = transitions.filter(
      (t) => t.result.liveRegionAnnouncements.length === 0,
    );

    out.push({
      rule: "C1",
      title: "Memoised subtree contains a live region",
      perfSide: `Component ${facts.memoized[0]?.name ?? ""} is wrapped in React.memo to avoid re-renders.`,
      a11ySide:
        `It contains an aria-live="${memoedLive[0].value}" region. If memoisation ` +
        `prevents the subtree re-rendering, the live region never mutates, and a ` +
        `screen reader announces nothing — the update is silent.`,
      evidence: [
        `Source: React.memo on ${facts.memoized[0]?.name ?? "component"}`,
        `Source: aria-live="${memoedLive[0].value}" inside that boundary`,
        ...(silentTransitions.length
          ? [
              `Runtime: ${silentTransitions.length} state transition(s) produced no ` +
                `live-region announcement (${silentTransitions.map((t) => t.label).join(", ")})`,
            ]
          : []),
      ],
      confidence: silentTransitions.length > 0 ? "observed" : "likely",
      anchor: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C2 — content-visibility / virtualization hides content from a11y       */
  /* ---------------------------------------------------------------------- */

  if (facts.contentVisibility.length > 0 || facts.virtualizationLibs.length > 0) {
    const perf = facts.virtualizationLibs.length
      ? `Uses ${facts.virtualizationLibs.join(", ")} to avoid rendering off-screen rows.`
      : `Uses content-visibility to skip rendering work for off-screen content.`;

    out.push({
      rule: "C2",
      title: "Rendering optimisation removes content from the accessibility tree",
      perfSide: perf,
      a11ySide:
        "Content skipped this way is absent from the accessibility tree, so screen " +
        "readers cannot browse it and in-page find does not match it. Without " +
        "correct list semantics (aria-setsize / aria-posinset) a user also cannot " +
        "tell how much content exists.",
      evidence: [
        ...facts.contentVisibility.map((v) => `Source: content-visibility — ${v}`),
        ...facts.virtualizationLibs.map((v) => `Source: imports ${v}`),
        ...(tree ? [`Runtime: accessibility tree exposes ${tree.totals.nodes} node(s)`] : []),
      ],
      confidence: "likely",
      anchor: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C3 — skeleton fixes layout shift, screams at screen readers            */
  /* ---------------------------------------------------------------------- */

  for (const state of facts.loadingStates) {
    if (state.hasAriaBusy || state.hasAriaLive) continue;

    const announced = transcript?.lines.filter((l) =>
      state.rendersText.some((t) => l.text.toLowerCase().includes(t.toLowerCase())),
    );

    out.push({
      rule: "C3",
      title: `Loading state "${state.identifier}" is unannounced and unmarked`,
      perfSide:
        "Rendering placeholder content while loading keeps layout stable and avoids " +
        "cumulative layout shift.",
      a11ySide:
        "The placeholder carries no aria-busy and sits in no live region, so a screen " +
        "reader either reads the placeholder text as if it were real content, or says " +
        "nothing at all when the real content arrives. The user has no way to know the " +
        "component is working.",
      evidence: [
        `Source: \`${state.identifier} && …\` renders ${
          state.rendersText.length ? state.rendersText.map((t) => `"${t}"`).join(", ") : "placeholder content"
        }`,
        "Source: no aria-busy and no aria-live on that branch",
        ...(announced?.length
          ? [`Runtime: transcript announces "${announced[0].text}" as ordinary content`]
          : []),
      ],
      confidence: announced?.length ? "observed" : "likely",
      anchor: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C5 — the biggest image is lazy-loaded                                  */
  /* ---------------------------------------------------------------------- */

  const lazyImages = facts.images.filter((img) => img.loading === "lazy");

  if (lazyImages.length > 0 && facts.images.length > 0) {
    // Real LCP is page-level and cannot be measured for one component, so this
    // is scoped honestly: the first image in source order is the one most
    // likely to be the largest contentful paint on the page that embeds it.
    const first = facts.images[0];
    if (first.loading === "lazy") {
      out.push({
        rule: "C5",
        title: "The first image in the component is lazy-loaded",
        perfSide: "loading=\"lazy\" defers off-screen images and saves bandwidth.",
        a11ySide:
          "Applied to the image most likely to be the largest contentful paint, it " +
          "delays the very thing the metric measures, pushing LCP later rather than " +
          "earlier. Lazy-load below-the-fold images only.",
        evidence: [
          `Source: <img src="${first.src ?? "?"}" loading="lazy"> is the first image in the component`,
          "Note: true LCP is a page-level metric and cannot be measured for an isolated component, so this is a source-level heuristic.",
        ],
        confidence: "possible",
        anchor: null,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* C7 — animation with no reduced-motion guard                            */
  /* ---------------------------------------------------------------------- */

  if (facts.animations.length > 0 && !facts.reducedMotionGuard) {
    out.push({
      rule: "C7",
      title: "Animation is not guarded by prefers-reduced-motion",
      perfSide:
        "Animations and transitions occupy the main thread and can cause dropped " +
        "frames on low-end devices.",
      a11ySide:
        "Nothing honours prefers-reduced-motion, so users who set that preference — " +
        "often because motion triggers migraine or vestibular symptoms — get the full " +
        "animation anyway. The same guard removes both the health risk and the work.",
      evidence: [
        ...facts.animations.slice(0, 3).map((a) => `Source: ${a.from} — ${a.value}`),
        "Source: no prefers-reduced-motion, useReducedMotion or motion-safe anywhere in the file",
      ],
      confidence: "observed",
      anchor: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C8 — barrel import alongside unlabelled controls                       */
  /* ---------------------------------------------------------------------- */

  const barrels = facts.imports.filter((i) => i.barrelRisk);

  if (barrels.length > 0) {
    const unnamed = focus?.stops.filter((s) => !s.name).length ?? 0;
    out.push({
      rule: "C8",
      title: `Barrel import from ${barrels[0].source}`,
      perfSide:
        `Named imports from ${barrels[0].source} (${barrels[0].specifiers.slice(0, 4).join(", ")}` +
        `${barrels[0].specifiers.length > 4 ? ", …" : ""}) can pull the entire package ` +
        `into the bundle when tree-shaking fails.`,
      a11ySide:
        unnamed > 0
          ? `The same icon set supplies ${unnamed} control(s) that have no accessible ` +
            `name, so the user pays the bytes and gets nothing announced.`
          : "Icons from these packages are decorative by default and need explicit " +
            "labelling wherever they carry meaning.",
      evidence: [
        `Source: import { ${barrels[0].specifiers.slice(0, 4).join(", ")} } from "${barrels[0].source}"`,
        ...(unnamed > 0 ? [`Runtime: ${unnamed} focusable control(s) with no accessible name`] : []),
      ],
      confidence: unnamed > 0 ? "observed" : "possible",
      anchor: null,
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Summary for the model                                                      */
/* -------------------------------------------------------------------------- */

export function summarizeCorrelations(candidates: CorrelationCandidate[]): string {
  if (!candidates.length) {
    return "No coupled accessibility/performance patterns detected in this component.";
  }

  return candidates
    .map((c) => {
      const evidence = c.evidence.map((e) => `      - ${e}`).join("\n");
      return [
        `  [${c.rule}] ${c.title}  (confidence: ${c.confidence})`,
        `    Performance side: ${c.perfSide}`,
        `    Accessibility cost: ${c.a11ySide}`,
        `    Evidence:`,
        evidence,
      ].join("\n");
    })
    .join("\n\n");
}
