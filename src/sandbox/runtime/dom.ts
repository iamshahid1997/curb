/**
 * DOM helpers used by the sandbox runtime and its probes.
 */

/**
 * Build a selector that survives a re-render.
 *
 * Deliberately prefers stable, semantic anchors over positional ones: a test id
 * or an id beats an accessible name, which beats an nth-child path. The agent
 * gets handed these selectors and feeds them straight back in `drive` actions,
 * so a brittle selector shows up as a mysteriously failing action several steps
 * later — worth the extra work here.
 */
export function selectorFor(el: Element | null): string | null {
  if (!el || el === document.body || el === document.documentElement) return null;

  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;

  if (el.id) return `#${cssEscape(el.id)}`;

  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node !== document.body && parts.length < 6) {
    let part = node.tagName.toLowerCase();

    const role = node.getAttribute("role");
    if (role) part += `[role="${cssEscape(role)}"]`;

    const label = node.getAttribute("aria-label");
    if (label) {
      part += `[aria-label="${cssEscape(label)}"]`;
      parts.unshift(part);
      break;
    }

    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName,
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }

    parts.unshift(part);
    node = parent;
  }

  return parts.length ? parts.join(" > ") : null;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

export function resolve(selector: string, root: ParentNode = document): Element {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`No element matches selector: ${selector}`);
  return el;
}

/** Elements that can hold keyboard focus, in DOM order. */
export function focusableElements(root: ParentNode): HTMLElement[] {
  const selector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "details > summary",
    "iframe",
    "audio[controls]",
    "video[controls]",
    "[contenteditable]",
    "[tabindex]",
  ].join(",");

  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    isActuallyFocusable,
  );
}

export function isActuallyFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.getAttribute("tabindex") === "-1") return false;
  if (el.closest("[inert]")) return false;

  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.contentVisibility === "hidden") return false;

  // A zero-size box is unreachable in practice even when the tree says otherwise.
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;

  return true;
}

/** Text a screen reader would announce for an element, roughly. */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const text = Array.from(labels)
        .map((l) => l.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder?.trim()) return placeholder.trim();
  }

  if (el instanceof HTMLImageElement) {
    return el.getAttribute("alt")?.trim() ?? "";
  }

  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim();

  return el.textContent?.trim().replace(/\s+/g, " ") ?? "";
}

export function countNodes(root: Element | null): number {
  if (!root) return 0;
  return root.querySelectorAll("*").length + 1;
}

/* -------------------------------------------------------------------------- */
/* React handler detection                                                    */
/* -------------------------------------------------------------------------- */

/**
 * React does not set `onclick` attributes — handlers live in its synthetic
 * event system, so `querySelectorAll('[onclick]')` finds nothing in a React
 * tree. React does however hang its props off the DOM node under a
 * `__reactProps$<hash>` key, which is how we recover them.
 *
 * Reaching into a React internal is a liability if the key name ever changes,
 * so every caller must degrade gracefully when this returns null rather than
 * treating absence as proof there is no handler.
 */
export function reactProps(el: Element): Record<string, unknown> | null {
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactProps$")) {
      const value = (el as unknown as Record<string, unknown>)[key];
      return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
    }
  }
  return null;
}

export function hasClickHandler(el: Element): boolean {
  if (el.hasAttribute("onclick")) return true;
  const props = reactProps(el);
  return typeof props?.onClick === "function";
}

export function hasKeyboardHandler(el: Element): boolean {
  const props = reactProps(el);
  if (!props) return false;
  return (
    typeof props.onKeyDown === "function" ||
    typeof props.onKeyUp === "function" ||
    typeof props.onKeyPress === "function"
  );
}

/** Elements that already respond to Enter/Space without extra wiring. */
export function isNativelyInteractive(el: Element): boolean {
  return /^(a|button|input|select|textarea|summary|details|option)$/i.test(el.tagName);
}
