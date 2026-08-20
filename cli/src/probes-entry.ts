/**
 * Probe bundle injected into the page under audit.
 *
 * Exactly the same probe code the browser sandbox used — axe, the accessibility
 * tree, the screen-reader transcript, the spec-correct focus tracer — but
 * exposed on `window.__curb` for Playwright to call directly instead of behind
 * a postMessage protocol. The probes never knew which host they were in, which
 * is why the pivot from an iframe to a real page costs nothing here.
 *
 * Deliberately excluded: source AST analysis. It is a pure function of text and
 * belongs on the Node side, where the files already are — shipping Babel into
 * every audited page would be 2.4MB for nothing.
 */

import axe from "axe-core";

/* -------------------------------------------------------------------------- */
/* Dev-tooling exclusion                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Framework dev overlays that are in the DOM of every dev server and belong to
 * none of the audited application.
 *
 * Found by dogfooding: pressing Tab landed focus on `nextjs-portal`, so the
 * first reported tab stop was Next's error overlay rather than anything the
 * developer wrote. Auditing must run against the application, not the toolchain
 * — otherwise every finding on every Next project is contaminated, and the
 * noise looks exactly like a real defect.
 */
const DEV_OVERLAY_SELECTORS = [
  "nextjs-portal",
  "#__next-build-watcher",
  "[data-nextjs-dialog-overlay]",
  "[data-nextjs-toast]",
  "vite-error-overlay",
  "#react-refresh-overlay",
  "#webpack-dev-server-client-overlay",
  "astro-dev-toolbar",
  "#curb-sandbox-host",
  "#__curb_focus_anchor",
];

/**
 * Take dev overlays out of the tab order permanently.
 *
 * Detaching only helps for DOM walks we control. A real Tab keypress from
 * Playwright uses the browser's actual sequential navigation, and Next's error
 * overlay is genuinely in it — so driving the page reported focus landing on
 * `nextjs-portal`. `inert` removes an element and its subtree from focus and
 * from assistive tech, which is exactly the semantics wanted, and our own
 * focusability check already honours it.
 */
function neutraliseDevOverlays(): number {
  let count = 0;

  for (const selector of DEV_OVERLAY_SELECTORS) {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (node.hasAttribute("inert")) continue;
      node.setAttribute("inert", "");
      node.setAttribute("aria-hidden", "true");
      count += 1;
    }
  }

  return count;
}

/**
 * Detach dev overlays for the duration of a probe, then put them back exactly
 * where they were. Detaching rather than hiding keeps them out of the
 * accessibility tree and out of tab order without touching their styles.
 */
function withoutDevOverlays<T>(fn: () => T): T {
  const parked: Array<{ node: Element; parent: Node; next: Node | null }> = [];

  for (const selector of DEV_OVERLAY_SELECTORS) {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (!node.parentNode) continue;
      parked.push({ node, parent: node.parentNode, next: node.nextSibling });
      node.parentNode.removeChild(node);
    }
  }

  try {
    return fn();
  } finally {
    for (const { node, parent, next } of parked.reverse()) {
      try {
        parent.insertBefore(node, next);
      } catch {
        /* the overlay re-rendered itself; nothing to restore */
      }
    }
  }
}

import {
  snapshotA11yTree,
  transcribe,
} from "../../src/sandbox/runtime/probes/a11y-tree";
import { traceFocusOrder } from "../../src/sandbox/runtime/probes/focus-order";
import {
  hasClickHandler,
  hasKeyboardHandler,
  isNativelyInteractive,
  selectorFor,
} from "../../src/sandbox/runtime/dom";

interface AxeViolationSummary {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: Array<{ target: string[]; html: string; failureSummary: string }>;
}

async function runAxe(rootSelector?: string) {
  const results = await axe.run(
    { include: [[rootSelector ?? "body"]], exclude: DEV_OVERLAY_SELECTORS.map((s) => [s]) } as never,
    { resultTypes: ["violations"], elementRef: false },
  );

  const violations: AxeViolationSummary[] = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.slice(0, 20).map((n) => ({
      target: n.target.map(String),
      html: n.html.slice(0, 300),
      failureSummary: n.failureSummary ?? "",
    })),
  }));

  return {
    violations,
    passCount: results.passes?.length ?? 0,
    incompleteCount: results.incomplete?.length ?? 0,
  };
}

/**
 * Selectors worth resolving back to source.
 *
 * The page can have thousands of nodes; only the ones implicated in a finding
 * are worth the cost of an owner-stack read and a source-map lookup.
 */
function interestingSelectors(): string[] {
  const out = new Set<string>();

  const focus = traceFocusOrder(document.body);
  for (const stop of focus.stops) if (stop.selector) out.add(stop.selector);
  for (const item of focus.unreachable) if (item.selector) out.add(item.selector);

  // Anything React wired a click onto that is not natively interactive.
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (isNativelyInteractive(el)) continue;
    if (!hasClickHandler(el)) continue;
    const selector = selectorFor(el);
    if (selector) out.add(selector);
  }

  // Images and live regions feed the correlation rules.
  for (const el of Array.from(document.querySelectorAll("img,[aria-live],[role='status'],[role='alert']"))) {
    const selector = selectorFor(el);
    if (selector) out.add(selector);
  }

  return Array.from(out).slice(0, 120);
}

/** Signals that need the real DOM rather than the source text. */
function domFacts() {
  const images = Array.from(document.querySelectorAll("img")).map((img) => {
    const rect = img.getBoundingClientRect();
    return {
      selector: selectorFor(img),
      src: img.getAttribute("src"),
      loading: img.getAttribute("loading"),
      alt: img.getAttribute("alt"),
      area: Math.round(rect.width * rect.height),
      aboveFold: rect.top < window.innerHeight,
    };
  });

  const liveRegions = Array.from(
    document.querySelectorAll("[aria-live],[role='status'],[role='alert']"),
  ).map((el) => ({
    selector: selectorFor(el),
    politeness: el.getAttribute("aria-live") ?? el.getAttribute("role"),
    busy: el.getAttribute("aria-busy"),
    text: (el.textContent ?? "").trim().slice(0, 120),
  }));

  const animated = Array.from(document.querySelectorAll("*"))
    .filter((el) => {
      const style = getComputedStyle(el);
      return (
        (style.animationName !== "none" && style.animationDuration !== "0s") ||
        (style.transitionDuration !== "0s" && style.transitionProperty !== "none")
      );
    })
    .slice(0, 20)
    .map((el) => ({
      selector: selectorFor(el),
      animation: getComputedStyle(el).animationName,
      duration: getComputedStyle(el).animationDuration,
    }));

  const contentVisibility = Array.from(document.querySelectorAll("*"))
    .filter((el) => {
      const cv = getComputedStyle(el).contentVisibility;
      return cv === "auto" || cv === "hidden";
    })
    .slice(0, 20)
    .map((el) => ({ selector: selectorFor(el), value: getComputedStyle(el).contentVisibility }));

  return { images, liveRegions, animated, contentVisibility };
}

/* -------------------------------------------------------------------------- */
/* Interaction driving                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Live-region announcements observed while an interaction runs.
 *
 * Playwright drives the click, but the mutation has to be watched from inside
 * the page, so the observer is armed here and drained afterwards.
 */
function watchAnnouncements(): void {
  const w = window as unknown as { __curbAnnouncements?: string[]; __curbObserver?: MutationObserver };
  w.__curbAnnouncements = [];
  w.__curbObserver?.disconnect();

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target =
        record.target.nodeType === Node.ELEMENT_NODE
          ? (record.target as Element)
          : record.target.parentElement;
      const region = target?.closest("[aria-live],[role='alert'],[role='status']");
      if (!region) continue;
      const text = (region.textContent ?? "").trim();
      if (text) w.__curbAnnouncements!.push(text.slice(0, 160));
    }
  });

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  w.__curbObserver = observer;
}

function drainAnnouncements(): string[] {
  const w = window as unknown as { __curbAnnouncements?: string[]; __curbObserver?: MutationObserver };
  const out = Array.from(new Set(w.__curbAnnouncements ?? []));
  w.__curbObserver?.disconnect();
  w.__curbAnnouncements = [];
  return out;
}

/**
 * Put focus at a known point so a following Tab is deterministic.
 *
 * Two things break naive tabbing. Focus can start inside an iframe, where Tab
 * moves through the frame's own document and never advances the parent's — the
 * first Tab of an audit did nothing at all for that reason. And `document.body`
 * is not focusable by default, so blurring alone leaves focus nowhere
 * well-defined.
 *
 * A zero-size anchor as the first child of body, focused with tabindex="-1",
 * makes the next Tab land on the document's genuine first tab stop. It carries
 * no role or text, and it is in the dev-overlay exclusion list so no probe ever
 * reports it.
 */
function resetFocusToStart(): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && typeof active.blur === "function") {
    active.blur();
  }

  let anchor = document.getElementById("__curb_focus_anchor");
  if (!anchor) {
    anchor = document.createElement("span");
    anchor.id = "__curb_focus_anchor";
    anchor.tabIndex = -1;
    anchor.setAttribute("aria-hidden", "true");
    anchor.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;opacity:0";
    document.body.insertBefore(anchor, document.body.firstChild);
  }

  anchor.focus();
}

function activeElementInfo() {
  const el = document.activeElement as HTMLElement | null;
  const lost = !el || el === document.body;
  return {
    selector: lost ? null : selectorFor(el),
    focusLostToBody: lost,
    tag: el?.tagName.toLowerCase() ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Export surface                                                             */
/* -------------------------------------------------------------------------- */

const api = {
  version: 1,
  runAxe,
  snapshotA11yTree: (selector?: string) =>
    withoutDevOverlays(() =>
      snapshotA11yTree((selector ? document.querySelector(selector) : null) ?? document.body),
    ),
  transcribe: (selector?: string) =>
    withoutDevOverlays(() =>
      transcribe((selector ? document.querySelector(selector) : null) ?? document.body),
    ),
  traceFocusOrder: (selector?: string) =>
    withoutDevOverlays(() =>
      traceFocusOrder(
        ((selector ? document.querySelector(selector) : null) ?? document.body) as HTMLElement,
      ),
    ),
  neutraliseDevOverlays,
  resetFocusToStart,
  interestingSelectors: () => withoutDevOverlays(interestingSelectors),
  domFacts: () => withoutDevOverlays(domFacts),
  watchAnnouncements,
  drainAnnouncements,
  activeElementInfo,
  hasClickHandler: (selector: string) => {
    const el = document.querySelector(selector);
    return el ? hasClickHandler(el) : false;
  },
  hasKeyboardHandler: (selector: string) => {
    const el = document.querySelector(selector);
    return el ? hasKeyboardHandler(el) : false;
  },
};

(window as unknown as { __curb: typeof api }).__curb = api;

export type CurbPageApi = typeof api;
