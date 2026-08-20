/**
 * Playwright driver — the CLI's replacement for the browser sandbox.
 *
 * The probes are unchanged; only the host is different. Where the web version
 * mounted one component in an opaque-origin iframe and spoke postMessage, this
 * loads the project's real pages and calls the same functions directly.
 *
 * Three things only become possible here:
 *   - real Core Web Vitals, because there is a real navigation to measure
 *   - real routes and real data, instead of one component in isolation
 *   - source locations, because the dev server ships source maps
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, ConsoleMessage, Page } from "playwright";

import { COLLECT_OWNER_FRAMES, INSTALL_OBSERVERS } from "./in-page.js";
import { SourceMapResolver, type SourceLocation } from "./source-map.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface DriveAction {
  kind: "click" | "hover" | "focus" | "type" | "key" | "tab" | "wait" | "scroll";
  selector?: string;
  text?: string;
  key?: string;
  times?: number;
  ms?: number;
}

export interface Vitals {
  ttfb: number | null;
  firstContentfulPaint: number | null;
  lcp: { value: number; element: string | null; loadingAttr: string | null } | null;
  cls: number;
  longTasks: Array<{ start: number; duration: number }>;
  resourceCount: number;
  transferBytes: number;
}

export interface PageProbe {
  url: string;
  title: string;
  axe: {
    violations: Array<{
      id: string;
      impact: string | null;
      help: string;
      helpUrl: string;
      nodes: Array<{ target: string[]; html: string; failureSummary: string }>;
    }>;
    passCount: number;
  };
  transcript: { lines: Array<{ text: string; role: string; selector: string | null; issues: string[] }>; disclaimer: string };
  focus: {
    stops: Array<Record<string, unknown>>;
    unreachable: Array<Record<string, unknown>>;
    positiveTabindexCount: number;
    modal: unknown;
    trap: unknown;
    notes: string[];
  };
  domFacts: {
    images: Array<{ selector: string | null; src: string | null; loading: string | null; alt: string | null; area: number; aboveFold: boolean }>;
    liveRegions: Array<{ selector: string | null; politeness: string | null; busy: string | null; text: string }>;
    animated: Array<{ selector: string | null; animation: string; duration: string }>;
    contentVisibility: Array<{ selector: string | null; value: string }>;
  };
  vitals: Vitals;
  consoleErrors: string[];
}

export interface DriveOutcome {
  completed: number;
  failed: string | null;
  focusLostToBody: boolean;
  activeElement: string | null;
  announcements: string[];
}

/** Shape of the probe API the injected bundle puts on `window`. */
interface CurbPageGlobals {
  __curb: {
    runAxe(selector?: string): Promise<unknown>;
    transcribe(selector?: string): unknown;
    traceFocusOrder(selector?: string): unknown;
    snapshotA11yTree(selector?: string): unknown;
    domFacts(): unknown;
    interestingSelectors(): string[];
    neutraliseDevOverlays(): number;
    resetFocusToStart(): void;
    watchAnnouncements(): void;
    drainAnnouncements(): string[];
    activeElementInfo(): { selector: string | null; focusLostToBody: boolean; tag: string | null };
  };
  __curbVitals: { lcp: Vitals["lcp"]; cls: number; longTasks: Vitals["longTasks"] };
}

declare global {
  // eslint-disable-next-line no-var
  var __curb: CurbPageGlobals["__curb"];
  // eslint-disable-next-line no-var
  var __curbVitals: CurbPageGlobals["__curbVitals"];
}

export class PageDriver {
  private readonly probeSource: string;
  private readonly consoleErrors: string[] = [];

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly sourceMaps: SourceMapResolver,
  ) {
    this.probeSource = readFileSync(join(here, "probes.js"), "utf8");

    page.on("console", (message: ConsoleMessage) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // React's dev warnings are probe signal, not noise, so they are kept.
      this.consoleErrors.push(text.slice(0, 300));
    });

    page.on("pageerror", (err) => {
      this.consoleErrors.push(`Uncaught: ${err.message}`.slice(0, 300));
    });
  }

  static async launch(options: {
    projectRoot: string;
    headless?: boolean;
    viewport?: { width: number; height: number };
    /** Themes fail differently; a light-only audit misses half the contrast bugs. */
    colorScheme?: "light" | "dark";
  }): Promise<PageDriver> {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      // Audit the default experience, not a reduced-motion one — C7 depends on
      // observing that animations are unguarded.
      reducedMotion: "no-preference",
      colorScheme: options.colorScheme ?? "light",
    });

    const page = await context.newPage();

    // Observers must exist before the navigation they are measuring.
    await page.addInitScript(`(${INSTALL_OBSERVERS})()`);

    return new PageDriver(browser, page, new SourceMapResolver(options.projectRoot));
  }

  get currentUrl(): string {
    return this.page.url();
  }

  async visit(url: string): Promise<void> {
    this.consoleErrors.length = 0;
    await this.page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await this.inject();
  }

  /** Re-inject after any navigation — a fresh document has no `__curb`. */
  private async inject(): Promise<void> {
    const present = await this.page.evaluate(() => typeof window.__curb !== "undefined");
    if (!present) await this.page.addScriptTag({ content: this.probeSource });

    await this.page.evaluate(() => {
      // Dev overlays are re-created on every navigation, so this runs each time.
      window.__curb.neutraliseDevOverlays();
      window.__curb.watchAnnouncements();
    });
  }

  async probe(): Promise<PageProbe> {
    await this.inject();

    const result = await this.page.evaluate(async () => ({
      title: document.title,
      axe: await window.__curb.runAxe(),
      transcript: window.__curb.transcribe(),
      focus: window.__curb.traceFocusOrder(),
      domFacts: window.__curb.domFacts(),
      vitals: window.__curbVitals,
    }));

    const navTiming = await this.page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const fcp = performance
        .getEntriesByType("paint")
        .find((p) => p.name === "first-contentful-paint");
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      return {
        ttfb: nav ? Math.round(nav.responseStart) : null,
        firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
        resourceCount: resources.length,
        transferBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
      };
    });

    const observed = result.vitals;

    return {
      url: this.page.url(),
      title: result.title as string,
      axe: result.axe as PageProbe["axe"],
      transcript: result.transcript as PageProbe["transcript"],
      focus: result.focus as PageProbe["focus"],
      domFacts: result.domFacts as PageProbe["domFacts"],
      vitals: {
        ...navTiming,
        lcp: observed?.lcp ?? null,
        cls: Math.round((observed?.cls ?? 0) * 1000) / 1000,
        longTasks: observed?.longTasks ?? [],
      },
      consoleErrors: Array.from(new Set(this.consoleErrors)),
    };
  }

  /**
   * Drive the page into a new state.
   *
   * Playwright dispatches trusted input, so unlike the iframe version this
   * exercises the real event path — a Tab keypress genuinely moves focus, and
   * a component's own key handlers run exactly as they would for a user.
   */
  async drive(actions: DriveAction[]): Promise<DriveOutcome> {
    await this.inject();

    let completed = 0;
    let failed: string | null = null;

    for (const action of actions) {
      try {
        await this.runAction(action);
        completed += 1;
      } catch (err) {
        failed = `${action.kind}${action.selector ? ` on "${action.selector}"` : ""}: ${
          err instanceof Error ? err.message.split("\n")[0] : String(err)
        }`;
        break;
      }
    }

    // Let effects and transitions settle before reading state.
    await this.page.waitForTimeout(250);

    const after = await this.page.evaluate(() => ({
      active: window.__curb.activeElementInfo(),
      announcements: window.__curb.drainAnnouncements(),
    }));

    return {
      completed,
      failed,
      focusLostToBody: after.active.focusLostToBody,
      activeElement: after.active.selector,
      announcements: after.announcements,
    };
  }

  private async runAction(action: DriveAction): Promise<void> {
    const timeout = 5_000;

    switch (action.kind) {
      case "wait":
        await this.page.waitForTimeout(Math.min(action.ms ?? 200, 3000));
        return;
      case "tab": {
        // Without this the first Tab can be swallowed by an iframe that already
        // holds focus, silently shifting the whole reported order by one.
        await this.page.evaluate(() => window.__curb.resetFocusToStart());
        for (let i = 0; i < Math.min(action.times ?? 1, 30); i += 1) {
          await this.page.keyboard.press("Tab");
        }
        return;
      }
      case "key":
        await this.page.keyboard.press(action.key ?? "Enter");
        return;
      case "scroll":
        await this.page.mouse.wheel(0, action.ms ?? 600);
        return;
      case "click":
        await this.page.locator(this.sel(action)).first().click({ timeout });
        return;
      case "hover":
        await this.page.locator(this.sel(action)).first().hover({ timeout });
        return;
      case "focus":
        await this.page.locator(this.sel(action)).first().focus({ timeout });
        return;
      case "type":
        await this.page.locator(this.sel(action)).first().fill(action.text ?? "", { timeout });
        return;
      default:
        throw new Error(`Unknown action "${action.kind}"`);
    }
  }

  private sel(action: DriveAction): string {
    if (!action.selector) throw new Error(`"${action.kind}" needs a selector`);
    return action.selector;
  }

  /**
   * Map selectors to the source that rendered them.
   *
   * This is what turns "a button somewhere has no name" into "Button at
   * components/primitives.tsx:107", and what collapses many violations sharing
   * one origin into a single root-cause finding.
   */
  async resolveSources(selectors: string[]): Promise<Map<string, SourceLocation>> {
    if (!selectors.length) return new Map();
    await this.inject();

    const frames = (await this.page.evaluate(
      `(${COLLECT_OWNER_FRAMES})(${JSON.stringify(selectors)})`,
    )) as Array<{
      selector: string;
      found: boolean;
      frame: { url: string; line: number; column: number } | null;
    }>;

    const out = new Map<string, SourceLocation>();

    for (const entry of frames) {
      if (!entry.found || !entry.frame) continue;
      const location = await this.sourceMaps.resolve(
        entry.frame.url,
        entry.frame.line,
        entry.frame.column,
      );
      if (location) out.set(entry.selector, location);
    }

    return out;
  }

  /** Selectors the probes consider worth resolving. */
  async interestingSelectors(): Promise<string[]> {
    await this.inject();
    return this.page.evaluate(() => window.__curb.interestingSelectors());
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: false });
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
