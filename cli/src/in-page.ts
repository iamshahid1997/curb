/**
 * Code that runs inside the audited page, via Playwright's evaluate.
 *
 * Kept as a source string rather than an imported function: Playwright
 * serialises the function it is given, so it cannot close over anything from
 * this module. Everything the page needs has to be self-contained.
 */

/**
 * Extract owner-stack frames for elements matching a selector.
 *
 * Returns the raw bundled position for each element. Resolving it to a source
 * file happens on the Node side, where the source maps live.
 */
export const COLLECT_OWNER_FRAMES = `
(selectors) => {
  const INTERNAL = /node_modules|react-stack-bottom-frame|react-stack-top-frame|jsxDEV|renderWithHooks|beginWork|performWorkOn/;

  function fiberOf(el) {
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$')) return el[key];
    }
    return null;
  }

  function frameFor(el) {
    // Walk up until a fiber carries a usable stack. The DOM node's own stack is
    // usually enough, but portals and cloned elements can lack one.
    let fiber = fiberOf(el);
    let depth = 0;

    while (fiber && depth < 12) {
      const stack = fiber._debugStack && fiber._debugStack.stack;
      if (stack) {
        for (const rawLine of stack.split('\\n')) {
          if (!rawLine.includes('http')) continue;
          if (INTERNAL.test(rawLine)) continue;
          const m = rawLine.match(/(https?:\\/\\/[^\\s)]+):(\\d+):(\\d+)/);
          if (m) return { url: m[1], line: Number(m[2]), column: Number(m[3]), depth: depth };
        }
      }
      fiber = fiber.return;
      depth += 1;
    }

    return null;
  }

  const out = [];
  for (const selector of selectors) {
    let el = null;
    try { el = document.querySelector(selector); } catch (e) { el = null; }
    if (!el) { out.push({ selector: selector, found: false }); continue; }
    const frame = frameFor(el);
    out.push({ selector: selector, found: true, frame: frame });
  }
  return out;
}
`;

/**
 * Real Core Web Vitals from the page being audited.
 *
 * These are page-level metrics and are only meaningful here — measuring them
 * against an isolated component, as the earlier version of Curb would have had
 * to, produces authoritative-looking nonsense.
 */
export const COLLECT_VITALS = `
() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = {};
  for (const entry of performance.getEntriesByType('paint')) {
    paints[entry.name] = Math.round(entry.startTime);
  }

  let lcp = null;
  const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
  if (lcpEntries.length) {
    const last = lcpEntries[lcpEntries.length - 1];
    lcp = {
      value: Math.round(last.startTime),
      element: last.element ? last.element.tagName.toLowerCase() : null,
      url: last.url || null,
      loadingAttr: last.element && last.element.getAttribute
        ? last.element.getAttribute('loading')
        : null,
    };
  }

  let cls = 0;
  for (const entry of performance.getEntriesByType('layout-shift')) {
    if (!entry.hadRecentInput) cls += entry.value;
  }

  const longTasks = performance.getEntriesByType('longtask').map(function (t) {
    return { start: Math.round(t.startTime), duration: Math.round(t.duration) };
  });

  return {
    ttfb: nav ? Math.round(nav.responseStart) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    firstPaint: paints['first-paint'] ?? null,
    firstContentfulPaint: paints['first-contentful-paint'] ?? null,
    lcp: lcp,
    cls: Math.round(cls * 1000) / 1000,
    longTasks: longTasks,
    resourceCount: performance.getEntriesByType('resource').length,
    transferBytes: performance.getEntriesByType('resource').reduce(function (sum, r) {
      return sum + (r.transferSize || 0);
    }, 0),
  };
}
`;

/** Registers a PerformanceObserver before the page loads so nothing is missed. */
export const INSTALL_OBSERVERS = `
() => {
  window.__curbVitals = { lcp: null, cls: 0, longTasks: [], inp: null };

  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      window.__curbVitals.lcp = {
        value: Math.round(last.startTime),
        element: last.element ? last.element.tagName.toLowerCase() : null,
        loadingAttr: last.element && last.element.getAttribute
          ? last.element.getAttribute('loading')
          : null,
      };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}

  try {
    new PerformanceObserver(function (list) {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__curbVitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}

  try {
    new PerformanceObserver(function (list) {
      for (const entry of list.getEntries()) {
        window.__curbVitals.longTasks.push({
          start: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
        });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
}
`;
