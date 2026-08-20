/**
 * Coupled accessibility × performance rules, against a real page.
 *
 * The component version of these rules had to guess at the performance half.
 * With a real navigation the guesses become measurements:
 *
 *   - C5 was "the first image in source order is probably the LCP element".
 *     Now the browser reports which element actually *was* the largest
 *     contentful paint, and whether that element carries loading="lazy".
 *   - C7 was "a className contains animate-". Now it is computed style on
 *     elements that are really animating.
 *   - C3 was "a branch renders text that looks like a skeleton". Now it is a
 *     live region that exists in the DOM with no aria-busy.
 *
 * Rules still emit candidates with evidence, never findings. The agent judges.
 */

import type { PageProbe } from "./driver.js";
import type { SourceLocation } from "./source-map.js";

export type Confidence = "measured" | "observed" | "likely";

export interface LiveCorrelation {
  rule: string;
  title: string;
  perfSide: string;
  a11ySide: string;
  evidence: string[];
  confidence: Confidence;
  selector: string | null;
  source: SourceLocation | null;
}

export interface CorrelationContext {
  probe: PageProbe;
  sources: Map<string, SourceLocation>;
  /** Source text of files implicated on this page, for the memo check. */
  sourceText: Map<string, string>;
  /** Interactions performed on this page and what was announced. */
  transitions: Array<{ label: string; announcements: string[] }>;
}

export function detectLiveCorrelations(ctx: CorrelationContext): LiveCorrelation[] {
  const { probe, sources, sourceText, transitions } = ctx;
  const out: LiveCorrelation[] = [];

  const sourceFor = (selector: string | null): SourceLocation | null =>
    selector ? (sources.get(selector) ?? null) : null;

  /* ---------------------------------------------------------------------- */
  /* C5 — the measured LCP element is lazy-loaded                           */
  /* ---------------------------------------------------------------------- */

  const lcp = probe.vitals.lcp;

  if (lcp?.loadingAttr === "lazy") {
    out.push({
      rule: "C5",
      title: "The element that produced LCP is lazy-loaded",
      perfSide:
        `loading="lazy" defers images that are not needed yet. Here the browser ` +
        `reported this exact element as the largest contentful paint at ` +
        `${lcp.value}ms.`,
      a11ySide:
        "Deferring the largest contentful paint delays the very thing the metric " +
        "measures, and delays the primary content for everyone — including users " +
        "on slow connections who benefit least from waiting. Lazy-load below the " +
        "fold only.",
      evidence: [
        `Measured: LCP fired at ${lcp.value}ms on <${lcp.element ?? "?"}>`,
        `Measured: that element has loading="lazy"`,
      ],
      confidence: "measured",
      selector: null,
      source: null,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C3 — a live region that never says it is busy                          */
  /* ---------------------------------------------------------------------- */

  for (const region of probe.domFacts.liveRegions) {
    if (region.busy) continue;

    const silent = transitions.filter((t) => t.announcements.length === 0);
    if (!silent.length && !region.text) continue;

    out.push({
      rule: "C3",
      title: "Live region carries no busy state",
      perfSide:
        "Rendering placeholder content in place keeps layout stable and avoids " +
        "cumulative layout shift while data loads.",
      a11ySide:
        `The region announces "${region.politeness}" but never sets aria-busy, so ` +
        `a screen reader reads placeholder text as if it were real content and ` +
        `gives no signal that the component is still working.`,
      evidence: [
        `DOM: ${region.selector ?? "(unknown)"} has aria-live="${region.politeness}" and no aria-busy`,
        region.text ? `DOM: it currently reads "${region.text}"` : "DOM: it is currently empty",
        ...(silent.length
          ? [`Runtime: ${silent.length} interaction(s) produced no announcement (${silent.map((t) => t.label).join(", ")})`]
          : []),
      ],
      confidence: silent.length ? "observed" : "likely",
      selector: region.selector,
      source: sourceFor(region.selector),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C1 — memoisation around a live region                                  */
  /* ---------------------------------------------------------------------- */

  const memoFiles = Array.from(sourceText.entries()).filter(([, text]) =>
    /\b(React\.)?memo\s*\(/.test(text),
  );

  if (memoFiles.length && probe.domFacts.liveRegions.length) {
    const silent = transitions.filter((t) => t.announcements.length === 0);

    if (silent.length) {
      out.push({
        rule: "C1",
        title: "Memoised component contains a live region that did not announce",
        perfSide: `${memoFiles[0][0]} wraps a component in memo to skip re-renders.`,
        a11ySide:
          "A live region only announces when its content actually mutates. If " +
          "memoisation prevents the subtree re-rendering, the update happens in " +
          "state but never in the DOM, and the announcement is silently lost.",
        evidence: [
          `Source: memo() in ${memoFiles[0][0]}`,
          `DOM: aria-live region at ${probe.domFacts.liveRegions[0].selector ?? "(unknown)"}`,
          `Runtime: ${silent.length} interaction(s) mutated no live region (${silent.map((t) => t.label).join(", ")})`,
        ],
        confidence: "observed",
        selector: probe.domFacts.liveRegions[0].selector,
        source: sourceFor(probe.domFacts.liveRegions[0].selector),
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* C2 — content-visibility removes content from the a11y tree             */
  /* ---------------------------------------------------------------------- */

  for (const node of probe.domFacts.contentVisibility) {
    out.push({
      rule: "C2",
      title: `content-visibility: ${node.value} skips rendering work and accessibility with it`,
      perfSide:
        `content-visibility: ${node.value} lets the browser skip layout and paint ` +
        `for this subtree until it is needed.`,
      a11ySide:
        "Content skipped this way is absent from the accessibility tree, so screen " +
        "readers cannot browse it and in-page find will not match it. With " +
        "`auto` the content returns when scrolled near; with `hidden` it never does " +
        "unless revealed in script.",
      evidence: [`Computed style: ${node.selector ?? "(unknown)"} has content-visibility: ${node.value}`],
      confidence: "measured",
      selector: node.selector,
      source: sourceFor(node.selector),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C7 — animation with no reduced-motion guard                            */
  /* ---------------------------------------------------------------------- */

  const animated = probe.domFacts.animated;
  const guardsMotion = Array.from(sourceText.values()).some((text) =>
    /prefers-reduced-motion|useReducedMotion|motion-safe|motion-reduce/i.test(text),
  );

  if (animated.length && !guardsMotion) {
    out.push({
      rule: "C7",
      title: `${animated.length} element(s) animate with no prefers-reduced-motion guard`,
      perfSide:
        "Animation occupies the main thread and compositor; on low-end devices it " +
        "is a measurable cost for decoration.",
      a11ySide:
        "Nothing honours prefers-reduced-motion, so users who set that preference — " +
        "often because motion triggers migraine or vestibular symptoms — get the " +
        "full animation regardless. One guard removes both the health risk and the " +
        "work.",
      evidence: [
        ...animated.slice(0, 3).map(
          (a) => `Computed style: ${a.selector ?? "?"} animates "${a.animation}" for ${a.duration}`,
        ),
        "Source: no prefers-reduced-motion, motion-safe or useReducedMotion in the files behind this page",
      ],
      confidence: "measured",
      selector: animated[0].selector,
      source: sourceFor(animated[0].selector),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* C4 — painted before it is operable                                     */
  /* ---------------------------------------------------------------------- */

  const blockingTasks = probe.vitals.longTasks.filter((t) => t.duration > 100);
  const fcp = probe.vitals.firstContentfulPaint;

  if (fcp !== null && blockingTasks.length) {
    const after = blockingTasks.filter((t) => t.start >= fcp);
    if (after.length) {
      const worst = after.reduce((a, b) => (a.duration > b.duration ? a : b));
      out.push({
        rule: "C4",
        title: "The page paints before it can respond",
        perfSide:
          `First contentful paint was at ${fcp}ms, but ${after.length} task(s) longer ` +
          `than 100ms ran after it — the longest blocking the main thread for ${worst.duration}ms.`,
        a11ySide:
          "The page looks ready while the main thread is blocked, so keystrokes and " +
          "clicks in that window are queued or dropped. Someone navigating by keyboard " +
          "hits a control that appears interactive and nothing happens, with no " +
          "feedback explaining why.",
        evidence: [
          `Measured: FCP ${fcp}ms`,
          ...after.slice(0, 3).map((t) => `Measured: ${t.duration}ms long task starting at ${t.start}ms`),
        ],
        confidence: "measured",
        selector: null,
        source: null,
      });
    }
  }

  return out;
}

export function summarizeLiveCorrelations(candidates: LiveCorrelation[]): string {
  if (!candidates.length) {
    return "  No coupled accessibility/performance patterns detected on this page.";
  }

  return candidates
    .map((c) => {
      const where = c.source ? ` [${c.source.file}:${c.source.line}]` : "";
      return [
        `  [${c.rule}] ${c.title} (${c.confidence})${where}`,
        `    Performance: ${c.perfSide}`,
        `    Accessibility cost: ${c.a11ySide}`,
        `    Evidence:`,
        ...c.evidence.map((e) => `      - ${e}`),
      ].join("\n");
    })
    .join("\n\n");
}
