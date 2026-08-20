/**
 * Accessibility tree snapshot and screen-reader transcript.
 *
 * Important limitation, stated here because the UI must repeat it: browsers do
 * not expose their real accessibility tree to JavaScript. Chrome's tree is only
 * reachable over the DevTools protocol, which we cannot use client-side. What
 * follows is a *model* of what a screen reader would announce, derived from the
 * DOM and ARIA semantics — not a capture from a real one.
 *
 * The model is only as good as its accessible-name computation, so that part is
 * delegated to axe-core's implementation of the ACCNAME spec rather than
 * hand-rolled. It is already in the bundle and it handles the cases that are
 * easy to get subtly wrong (aria-labelledby chains, label association, fallback
 * content, presentational role inheritance).
 */

import axe from "axe-core";
import { withAxeContext } from "../axe-context";
import { selectorFor } from "../dom";

/* -------------------------------------------------------------------------- */
/* axe internals                                                              */
/* -------------------------------------------------------------------------- */

interface AxeCommons {
  text: { accessibleText(node: Element): string; sanitize(s: string): string };
  aria: { getRole(node: Element, opts?: { noPresentational?: boolean }): string | null };
  dom: { isVisibleToScreenReaders?(node: Element): boolean };
}

function commons(): AxeCommons {
  const c = (axe as unknown as { commons?: AxeCommons }).commons;
  if (!c) throw new Error("axe.commons unavailable — the full axe build is required.");
  return c;
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type NameQuality = "ok" | "empty" | "suspicious";

export interface A11yNode {
  tag: string;
  role: string;
  name: string;
  nameQuality: NameQuality;
  /** Why the name was judged suspicious. Fed to the agent as evidence. */
  nameNote?: string;
  level?: number;
  states: string[];
  selector: string | null;
  focusable: boolean;
  children: A11yNode[];
}

export interface TranscriptLine {
  /** Roughly what a screen reader would speak for this node. */
  text: string;
  role: string;
  selector: string | null;
  issues: string[];
}

export interface A11yTreeResult {
  tree: A11yNode | null;
  /** Flattened counts, handy for the agent's triage. */
  totals: { nodes: number; unnamed: number; suspicious: number; landmarks: number };
  headingOutline: Array<{ level: number; text: string; selector: string | null }>;
}

export interface TranscriptResult {
  lines: TranscriptLine[];
  /** Prose form — this is what gets shown to non-experts. */
  prose: string;
  disclaimer: string;
}

const DISCLAIMER =
  "Modelled from the DOM and ARIA semantics. Browsers do not expose their real " +
  "accessibility tree to JavaScript, so this approximates what a screen reader " +
  "would announce rather than capturing a real one.";

/* -------------------------------------------------------------------------- */
/* Name quality                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Names that satisfy every rule engine and tell a user nothing. This is the
 * "semantic gap" the whole product is built around, so the checks are
 * deliberately opinionated.
 */
const PLACEHOLDER_NAMES = new Set([
  "image", "img", "photo", "picture", "icon", "logo", "graphic", "spacer",
  "click here", "click", "here", "read more", "more", "learn more", "link",
  "button", "submit", "untitled", "placeholder", "text", "label", "input",
  "field", "item", "element", "div", "thing", "todo", "tbd", "lorem ipsum",
]);

const FILENAME_LIKE = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i;
const GENERIC_SEQUENCE = /^(image|img|icon|photo|picture|item|button|link|field)[\s._-]*\d+$/i;
const HASH_LIKE = /^[a-f0-9]{8,}$/i;

function judgeName(name: string, role: string): { quality: NameQuality; note?: string } {
  const trimmed = name.trim();

  if (!trimmed) {
    return { quality: "empty", note: "No accessible name." };
  }

  const lower = trimmed.toLowerCase();

  if (PLACEHOLDER_NAMES.has(lower)) {
    return {
      quality: "suspicious",
      note: `"${trimmed}" is a generic placeholder — it does not describe this ${role}.`,
    };
  }

  if (GENERIC_SEQUENCE.test(trimmed)) {
    return {
      quality: "suspicious",
      note: `"${trimmed}" looks auto-generated rather than descriptive.`,
    };
  }

  if (FILENAME_LIKE.test(trimmed)) {
    return {
      quality: "suspicious",
      note: `"${trimmed}" is a filename, not a description of the image.`,
    };
  }

  if (HASH_LIKE.test(trimmed)) {
    return { quality: "suspicious", note: `"${trimmed}" looks like an id or hash.` };
  }

  if (role === "link" && /^https?:\/\//i.test(trimmed)) {
    return { quality: "suspicious", note: "Link is named by its raw URL." };
  }

  if (trimmed.length === 1 && !/\d/.test(trimmed)) {
    return { quality: "suspicious", note: "Single-character name conveys nothing." };
  }

  return { quality: "ok" };
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

function statesOf(el: Element): string[] {
  const states: string[] = [];
  const attr = (n: string) => el.getAttribute(n);

  if (el.hasAttribute("disabled") || attr("aria-disabled") === "true") states.push("disabled");
  if (attr("aria-expanded") === "true") states.push("expanded");
  if (attr("aria-expanded") === "false") states.push("collapsed");
  if (attr("aria-checked") === "true") states.push("checked");
  if (attr("aria-checked") === "false") states.push("not checked");
  if (attr("aria-selected") === "true") states.push("selected");
  if (attr("aria-current")) states.push("current");
  if (attr("aria-required") === "true" || el.hasAttribute("required")) states.push("required");
  if (attr("aria-invalid") === "true") states.push("invalid");
  if (attr("aria-busy") === "true") states.push("busy");
  if (attr("aria-modal") === "true") states.push("modal");
  if (attr("aria-live")) states.push(`live: ${attr("aria-live")}`);
  if (attr("aria-hidden") === "true") states.push("hidden from a11y tree");
  if (el instanceof HTMLInputElement && el.checked) states.push("checked");

  return states;
}

const LANDMARK_ROLES = new Set([
  "banner", "navigation", "main", "complementary", "contentinfo", "search",
  "form", "region",
]);

function isFocusable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hasAttribute("disabled")) return false;
  const ti = el.getAttribute("tabindex");
  if (ti !== null) return Number(ti) >= 0;
  return /^(a|button|input|select|textarea|summary|audio|video|iframe)$/i.test(el.tagName);
}

function isHiddenFromA11y(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("inert")) return true;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Tree construction                                                          */
/* -------------------------------------------------------------------------- */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "NOSCRIPT"]);

function buildNode(el: Element, c: AxeCommons): A11yNode | null {
  if (SKIP_TAGS.has(el.tagName)) return null;
  if (isHiddenFromA11y(el)) return null;

  let role = "";
  let name = "";

  try {
    role = c.aria.getRole(el) ?? "";
  } catch {
    role = "";
  }

  try {
    name = c.text.accessibleText(el) ?? "";
  } catch {
    name = "";
  }

  const children: A11yNode[] = [];
  for (const child of Array.from(el.children)) {
    const node = buildNode(child, c);
    if (node) children.push(node);
  }

  // Elements with no role, no name and no interesting children add only noise.
  const generic = !role || role === "generic" || role === "presentation" || role === "none";
  if (generic && !name && children.length === 0) return null;
  if (generic && children.length === 1) return children[0];

  // Only judge names on roles where a name actually matters.
  const nameMatters =
    /^(button|link|img|heading|textbox|combobox|checkbox|radio|switch|tab|menuitem|option|dialog|alertdialog|region|navigation|form|searchbox|slider|spinbutton|progressbar|treeitem)$/.test(
      role,
    );

  const judged = nameMatters ? judgeName(name, role) : { quality: "ok" as NameQuality };

  const level =
    role === "heading"
      ? Number(el.getAttribute("aria-level") ?? el.tagName.match(/^H([1-6])$/)?.[1] ?? 0) ||
        undefined
      : undefined;

  return {
    tag: el.tagName.toLowerCase(),
    role: role || "generic",
    name,
    nameQuality: judged.quality,
    nameNote: judged.note,
    level,
    states: statesOf(el),
    selector: selectorFor(el),
    focusable: isFocusable(el),
    children,
  };
}

export function snapshotA11yTree(root: Element): A11yTreeResult {
  const c = commons();

  const tree = withAxeContext(() => buildNode(root, c));

  const totals = { nodes: 0, unnamed: 0, suspicious: 0, landmarks: 0 };
  const headingOutline: A11yTreeResult["headingOutline"] = [];

  const walk = (node: A11yNode) => {
    totals.nodes += 1;
    if (node.nameQuality === "empty") totals.unnamed += 1;
    if (node.nameQuality === "suspicious") totals.suspicious += 1;
    if (LANDMARK_ROLES.has(node.role)) totals.landmarks += 1;
    if (node.role === "heading") {
      headingOutline.push({
        level: node.level ?? 0,
        text: node.name,
        selector: node.selector,
      });
    }
    node.children.forEach(walk);
  };

  if (tree) walk(tree);

  return { tree, totals, headingOutline };
}

/* -------------------------------------------------------------------------- */
/* Transcript                                                                 */
/* -------------------------------------------------------------------------- */

/** How a screen reader prefixes or suffixes each role when speaking it. */
function speak(node: A11yNode): string {
  const name = node.name.trim();
  const states = node.states.length ? `, ${node.states.join(", ")}` : "";

  switch (node.role) {
    case "heading":
      return `Heading level ${node.level ?? "?"}, ${name || "(no text)"}${states}`;
    case "button":
      return `${name || "(unlabelled)"}, button${states}`;
    case "link":
      return `${name || "(unlabelled)"}, link${states}`;
    case "img":
      return name ? `${name}, image` : `(unlabelled image)`;
    case "textbox":
    case "searchbox":
      return `${name || "(unlabelled)"}, edit text${states}`;
    case "combobox":
      return `${name || "(unlabelled)"}, combo box${states}`;
    case "checkbox":
      return `${name || "(unlabelled)"}, check box${states}`;
    case "radio":
      return `${name || "(unlabelled)"}, radio button${states}`;
    case "dialog":
    case "alertdialog":
      return `${name || "(untitled)"}, dialog${states}`;
    case "list":
      return `List with ${node.children.length} items`;
    case "listitem":
      return `${name}${states}`;
    case "navigation":
      return `${name || ""} navigation landmark`.trim();
    case "main":
      return "Main landmark";
    case "banner":
      return "Banner landmark";
    case "contentinfo":
      return "Content info landmark";
    case "region":
      return `${name || "(unnamed)"}, region${states}`;
    case "status":
      return `Status: ${name}`;
    case "alert":
      return `Alert: ${name}`;
    case "progressbar":
      return `${name || "(unlabelled)"}, progress bar${states}`;
    default:
      return name ? `${name}${states}` : "";
  }
}

function issuesFor(node: A11yNode): string[] {
  const issues: string[] = [];
  if (node.nameQuality === "empty") issues.push("no accessible name");
  if (node.nameQuality === "suspicious" && node.nameNote) issues.push(node.nameNote);
  if (node.states.includes("hidden from a11y tree") && node.focusable) {
    issues.push("focusable but hidden from assistive tech");
  }
  return issues;
}

export function transcribe(root: Element): TranscriptResult {
  const { tree } = snapshotA11yTree(root);
  const lines: TranscriptLine[] = [];

  const walk = (node: A11yNode) => {
    // A generic container's accessible name is just its descendants' text
    // concatenated. Emitting it would announce the whole subtree once as a
    // run-on line and then again node by node, which is noise, not signal.
    const isGenericContainer = node.role === "generic" && node.children.length > 0;

    if (!isGenericContainer) {
      const text = speak(node);
      if (text) {
        lines.push({
          text,
          role: node.role,
          selector: node.selector,
          issues: issuesFor(node),
        });
      }
    }

    node.children.forEach(walk);
  };

  if (tree) walk(tree);

  return {
    lines,
    prose: lines.map((l) => l.text).join(". ") + (lines.length ? "." : ""),
    disclaimer: DISCLAIMER,
  };
}
