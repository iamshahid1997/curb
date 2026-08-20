/**
 * Keyboard focus order, traps, and unreachable controls.
 *
 * JavaScript cannot synthesise a real Tab keypress — dispatching a KeyboardEvent
 * does not move focus. So this does two things and reconciles them:
 *
 *   1. Computes the spec's *sequential focus navigation order* statically:
 *      positive tabindex values first in ascending order, then everything else
 *      in DOM order. Getting this right matters, because positive tabindex is
 *      both a common defect and invisible to a naive DOM-order walk.
 *
 *   2. Dispatches a real `keydown` for Tab before applying that order. If the
 *      component calls preventDefault (which is how every focus trap and
 *      roving-tabindex widget is implemented), we let the component's own
 *      handler decide where focus goes and record what it did. Otherwise we
 *      apply the browser's default behaviour ourselves.
 *
 * Without step 2, every JS-implemented focus trap would be invisible; without
 * step 1, tab order would be wrong wherever positive tabindex appears.
 */

import axe from "axe-core";
import { withAxeContext } from "../axe-context";
import {
  assertLayoutAvailable,
  hasClickHandler,
  hasKeyboardHandler,
  isNativelyInteractive,
  selectorFor,
} from "../dom";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

/**
 * "indeterminate" means we could not tell, not that it is fine. See
 * measureFocusIndicator for why that distinction is load-bearing.
 */
export type FocusIndicator = "visible" | "suppressed" | "indeterminate";

export interface FocusStop {
  order: number;
  selector: string | null;
  tag: string;
  role: string;
  name: string;
  tabindex: number | null;
  /** Reached earlier than DOM order because of a positive tabindex. */
  reorderedByTabindex: boolean;
  /** Focusable but hidden from assistive tech — reachable yet unannounced. */
  ariaHidden: boolean;
  /** Visible focus indicator state (WCAG 2.4.7). */
  focusIndicator: FocusIndicator;
}

export interface UnreachableControl {
  selector: string | null;
  tag: string;
  role: string;
  name: string;
  reason: string;
}

export interface FocusOrderResult {
  stops: FocusStop[];
  /** Elements that look interactive but never receive focus. */
  unreachable: UnreachableControl[];
  positiveTabindexCount: number;
  /**
   * Set when a modal dialog is open. `contains` is false when focus can escape
   * the dialog into background content, which is a defect.
   */
  modal: { selector: string | null; contains: boolean; escapes: string[] } | null;
  /**
   * Set when focus cycles within a subset of the page with no modal open —
   * a keyboard trap under WCAG 2.1.2.
   */
  trap: { containerSelector: string | null; cycleLength: number } | null;
  /** True when the component handled Tab itself at least once. */
  componentHandlesTab: boolean;
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* Focusability                                                               */
/* -------------------------------------------------------------------------- */

function isRendered(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.contentVisibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  // A collapsed box with no painted area is unreachable in practice.
  if (rect.width === 0 && rect.height === 0 && style.position !== "fixed") return false;
  return true;
}

function isDisabled(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return true;
  if (el.closest("fieldset[disabled]")) return true;
  if (el.closest("[inert]")) return true;
  return false;
}

/**
 * Roles managed by arrow keys rather than Tab, and the container each belongs
 * to. In these widgets exactly one item carries tabindex=0 and the rest carry
 * -1 — that is the correct pattern, not a defect.
 */
const COMPOSITE_ROLES: Record<string, string> = {
  tab: "tablist",
  menuitem: "menu,menubar",
  menuitemcheckbox: "menu,menubar",
  menuitemradio: "menu,menubar",
  option: "listbox",
  treeitem: "tree",
  gridcell: "grid,treegrid",
  row: "grid,treegrid,table",
  radio: "radiogroup",
};

/**
 * True when a negative tabindex is deliberate roving-tabindex management.
 *
 * Found by dogfooding: the tab bar in Curb's own UI was reported as three
 * unreachable buttons, because a tablist correctly gives its inactive tabs
 * tabindex=-1 and moves focus with arrow keys. Reporting that as a keyboard
 * defect is a confident wrong answer about a correct implementation, which is
 * worse than missing a real one.
 *
 * The signal is not the role alone — anyone can write role="tab" and get it
 * wrong — but the presence of a sibling with the same role that IS in the tab
 * order. That is what distinguishes managed focus from simply unreachable.
 */
function isRovingTabindex(el: HTMLElement): boolean {
  const role = el.getAttribute("role");
  if (!role) return false;

  const containerRoles = COMPOSITE_ROLES[role];
  if (!containerRoles) return false;

  const containerSelector = containerRoles
    .split(",")
    .map((r) => `[role='${r}']`)
    .join(",");

  const container = el.closest(containerSelector);
  if (!container) return false;

  const siblings = Array.from(container.querySelectorAll<HTMLElement>(`[role='${role}']`));
  return siblings.some((sibling) => {
    if (sibling === el) return false;
    const ti = sibling.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0;
  });
}

function tabindexOf(el: HTMLElement): number | null {
  const raw = el.getAttribute("tabindex");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The spec's sequential focus navigation order.
 * Positive tabindex first (ascending, ties in DOM order), then the rest in DOM
 * order. tabindex < 0 is excluded from sequential navigation entirely.
 */
export function computeFocusOrder(root: ParentNode): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

  const eligible = candidates.filter((el) => {
    if (isDisabled(el)) return false;
    if (!isRendered(el)) return false;
    const ti = tabindexOf(el);
    if (ti !== null && ti < 0) return false;
    // <a> without href is not focusable; the selector already requires href.
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") return false;
    return true;
  });

  const positive: HTMLElement[] = [];
  const natural: HTMLElement[] = [];

  for (const el of eligible) {
    const ti = tabindexOf(el);
    if (ti !== null && ti > 0) positive.push(el);
    else natural.push(el);
  }

  positive.sort((a, b) => {
    const diff = (tabindexOf(a) ?? 0) - (tabindexOf(b) ?? 0);
    if (diff !== 0) return diff;
    // Ties resolve in DOM order.
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  return [...positive, ...natural];
}

/* -------------------------------------------------------------------------- */
/* Describing a stop                                                          */
/* -------------------------------------------------------------------------- */

interface AxeCommons {
  text: { accessibleText(node: Element): string };
  aria: { getRole(node: Element): string | null };
}

/**
 * State of the visible focus indicator (WCAG 2.4.7).
 *
 * Only measurable while the element is focused — unfocused elements report
 * `outline-style: none` under default UA styles, so checking cold flags every
 * control on the page.
 *
 * Even focused, this is not always decidable. Most focus styling is written
 * against `:focus-visible`, which the browser only matches when it judges the
 * focus to have come from the keyboard. A programmatic `.focus()` often does
 * not qualify, so the element can look unstyled here while being perfectly
 * styled for a real keyboard user. When `:focus-visible` does not match we
 * report "indeterminate" rather than guessing — a confident wrong finding costs
 * more than a missing one.
 */
function measureFocusIndicator(el: HTMLElement): FocusIndicator {
  const previous = document.activeElement as HTMLElement | null;
  el.focus();

  try {
    const style = getComputedStyle(el);
    const hasOutline = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    const hasShadow = style.boxShadow !== "none";
    const hasBorder = style.borderStyle !== "none" && style.borderWidth !== "0px";

    if (hasOutline || hasShadow || hasBorder) return "visible";

    // Nothing visible right now. Only call that a defect if the browser agrees
    // this is a keyboard-style focus; otherwise we cannot tell.
    let focusVisible = false;
    try {
      focusVisible = el.matches(":focus-visible");
    } catch {
      return "indeterminate";
    }

    return focusVisible ? "suppressed" : "indeterminate";
  } finally {
    if (previous && previous !== el) previous.focus();
  }
}

function describe(el: HTMLElement, order: number, reordered: boolean): FocusStop {
  const c = (axe as unknown as { commons?: AxeCommons }).commons;

  let role = "";
  let name = "";
  if (c) {
    withAxeContext(() => {
      try {
        role = c.aria.getRole(el) ?? "";
        name = c.text.accessibleText(el) ?? "";
      } catch {
        /* fall through to empty */
      }
    });
  }

  const focusIndicator = measureFocusIndicator(el);

  return {
    order,
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    role: role || el.tagName.toLowerCase(),
    name,
    tabindex: tabindexOf(el),
    reorderedByTabindex: reordered,
    ariaHidden: el.closest("[aria-hidden='true']") !== null,
    focusIndicator,
  };
}

/* -------------------------------------------------------------------------- */
/* Modal detection                                                            */
/* -------------------------------------------------------------------------- */

function openModal(root: ParentNode): HTMLElement | null {
  const explicit = root.querySelector<HTMLElement>(
    "[aria-modal='true'],dialog[open],[role='alertdialog']",
  );
  if (explicit) return explicit;

  // A role=dialog that is currently rendered counts too — components very often
  // omit aria-modal, and that omission is itself worth reporting.
  const dialog = root.querySelector<HTMLElement>("[role='dialog']");
  return dialog && isRendered(dialog) ? dialog : null;
}

/* -------------------------------------------------------------------------- */
/* Main probe                                                                 */
/* -------------------------------------------------------------------------- */

export function traceFocusOrder(root: HTMLElement, maxTabs = 40): FocusOrderResult {
  // Focusability is decided partly on geometry, so a frame with no layout would
  // report every control as unreachable. Refuse rather than lie.
  assertLayoutAvailable();

  const notes: string[] = [];

  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const staticOrder = computeFocusOrder(root);
  const domOrder = candidates;

  // An empty focus order on a component that clearly has controls is a probe
  // failure, not a finding — say so rather than silently reporting "nothing
  // focusable" and letting the agent conclude the component is fine.
  if (candidates.length > 0 && staticOrder.length === 0) {
    const why = candidates.map((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        `${el.tagName.toLowerCase()}: display=${style.display} ` +
        `visibility=${style.visibility} rect=${Math.round(rect.width)}x${Math.round(rect.height)} ` +
        `tabindex=${el.getAttribute("tabindex") ?? "none"} disabled=${el.hasAttribute("disabled")}`
      );
    });
    notes.push(
      `PROBE ANOMALY: ${candidates.length} focusable candidate(s) were all filtered out — ` +
        `treat this as a probe failure, not as "no keyboard issues". ` +
        why.join(" | "),
    );
  }

  if (candidates.length === 0) {
    notes.push(
      `PROBE ANOMALY: no focusable candidates matched inside <${root.tagName.toLowerCase()}` +
        `${root.id ? `#${root.id}` : ""}>, which contains ${root.querySelectorAll("*").length} element(s).`,
    );
  }

  const positiveTabindexCount = staticOrder.filter((el) => (tabindexOf(el) ?? 0) > 0).length;

  const stops: FocusStop[] = staticOrder.map((el, i) => {
    const domIndex = domOrder.indexOf(el);
    const reordered = (tabindexOf(el) ?? 0) > 0 && domIndex !== i;
    return describe(el, i + 1, reordered);
  });

  /* -- walk Tab, letting the component intercept ------------------------- */

  let componentHandlesTab = false;
  const visited: HTMLElement[] = [];

  const first = staticOrder[0];
  if (first) {
    first.focus();
    let current: HTMLElement | null = document.activeElement as HTMLElement | null;

    for (let i = 0; i < Math.min(maxTabs, staticOrder.length * 2 + 4); i += 1) {
      if (!current) break;
      visited.push(current);

      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      const notPrevented = current.dispatchEvent(event);

      if (!notPrevented) {
        // The component is managing Tab itself — a focus trap, a roving
        // tabindex, or a custom widget. Trust wherever it put focus.
        componentHandlesTab = true;
        const after = document.activeElement as HTMLElement | null;
        if (after === current) {
          notes.push(
            "Component called preventDefault on Tab but did not move focus — " +
              "keyboard navigation is stuck here.",
          );
          break;
        }
        current = after;
        continue;
      }

      // Apply the browser default ourselves.
      const index = staticOrder.indexOf(current);
      const next = staticOrder[(index + 1) % staticOrder.length];
      if (!next) break;
      next.focus();
      current = document.activeElement as HTMLElement | null;

      if (current === visited[0] && visited.length > 1) break; // full cycle
    }
  }

  /* -- modal containment ------------------------------------------------- */

  const modalEl = openModal(root);
  let modal: FocusOrderResult["modal"] = null;

  if (modalEl) {
    const escapes = stops
      .filter((s) => {
        if (!s.selector) return false;
        const el = root.querySelector(s.selector);
        return el ? !modalEl.contains(el) : false;
      })
      .map((s) => s.selector ?? "(unknown)");

    modal = {
      selector: selectorFor(modalEl),
      contains: escapes.length === 0,
      escapes,
    };

    if (!modal.contains && !componentHandlesTab) {
      notes.push(
        `A dialog is open but ${escapes.length} focusable element(s) outside it ` +
          `remain reachable by Tab. Focus should be contained while a modal is open.`,
      );
    }
    if (modalEl.getAttribute("aria-modal") !== "true" && modalEl.tagName !== "DIALOG") {
      notes.push(
        "Dialog is missing aria-modal=\"true\", so assistive tech will not treat " +
          "background content as inert.",
      );
    }
  }

  /* -- keyboard trap ----------------------------------------------------- */

  let trap: FocusOrderResult["trap"] = null;
  const uniqueVisited = new Set(visited);

  if (
    !modalEl &&
    componentHandlesTab &&
    uniqueVisited.size > 0 &&
    uniqueVisited.size < staticOrder.length
  ) {
    const container = visited[0]?.parentElement ?? null;
    trap = { containerSelector: selectorFor(container), cycleLength: uniqueVisited.size };
    notes.push(
      `Focus cycles among ${uniqueVisited.size} of ${staticOrder.length} controls with no ` +
        `modal open — this is a keyboard trap (WCAG 2.1.2).`,
    );
  }

  /* -- unreachable interactive elements ---------------------------------- */

  const unreachable: UnreachableControl[] = [];
  const reachable = new Set(staticOrder);

  // Anything given an interactive role, plus anything React wired a click
  // handler onto. The latter cannot be found with a `[onclick]` selector —
  // React keeps handlers in its synthetic event system, never as attributes —
  // so we read them off the fiber props instead.
  const roleSuspects = Array.from(
    root.querySelectorAll<HTMLElement>(
      "[role='button'],[role='link'],[role='tab'],[role='menuitem'],[role='checkbox'],[role='switch']",
    ),
  );
  const clickSuspects = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
    (el) => !isNativelyInteractive(el) && hasClickHandler(el),
  );

  const suspects = new Set<HTMLElement>([...roleSuspects, ...clickSuspects]);

  for (const el of suspects) {
    if (reachable.has(el)) continue;
    if (!isRendered(el)) continue;
    if (isRovingTabindex(el)) continue;

    const ti = tabindexOf(el);
    const clickable = hasClickHandler(el);
    const keyable = hasKeyboardHandler(el);

    let reason: string;
    if (ti !== null && ti < 0) {
      reason = "tabindex is negative, so Tab never reaches it";
    } else if (clickable && !keyable) {
      reason =
        `<${el.tagName.toLowerCase()}> has an onClick handler but is not focusable ` +
        `and has no keyboard handler — it is mouse-only`;
    } else if (clickable) {
      reason =
        `<${el.tagName.toLowerCase()}> handles keys but cannot receive focus, ` +
        `so the handler never fires`;
    } else {
      reason = "not a natively focusable element and has no tabindex";
    }

    unreachable.push({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      name: (el.textContent ?? "").trim().slice(0, 80),
      reason,
    });
  }

  for (const stop of stops) {
    if (stop.ariaHidden) {
      notes.push(
        `${stop.selector ?? stop.tag} is reachable by Tab but sits inside ` +
          `aria-hidden="true" — a keyboard user lands on something a screen reader ` +
          `will not announce.`,
      );
    }
  }

  if (positiveTabindexCount > 0) {
    notes.push(
      `${positiveTabindexCount} element(s) use a positive tabindex, overriding DOM ` +
        `order. This is fragile and almost always a defect.`,
    );
  }

  return {
    stops,
    unreachable,
    positiveTabindexCount,
    modal,
    trap,
    componentHandlesTab,
    notes,
  };
}
