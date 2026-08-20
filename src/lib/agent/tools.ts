/**
 * Tool contracts shared by both halves of the loop.
 *
 * The schemas are declared here so the server can describe the tools to the
 * model while the client executes them against the sandbox. Nothing in this
 * file touches the DOM — it must stay importable from a route handler.
 *
 * Note `apply_patch`: its result is the *oracle's verdict*, not an
 * acknowledgement. The model cannot mark something fixed that the probes did
 * not confirm, because the only way to apply a patch is to receive that verdict
 * back. The invariant is structural rather than a matter of prompting.
 */

import { z } from "zod";

export const ACTION_KINDS = [
  "click",
  "dblclick",
  "hover",
  "focus",
  "blur",
  "type",
  "key",
  "tab",
  "submit",
  "wait",
] as const;

/**
 * Deliberately permissive.
 *
 * A strict discriminated union on `kind` looked correct and failed in practice:
 * the model emits `{ "type": "click" }` because that is the near-universal
 * convention for tagged unions, and a schema rejection surfaces as a hard tool
 * error rather than something it can recover from.
 *
 * So the wire schema accepts either key and the client normalises and validates,
 * where a malformed action can be answered with a corrective message the model
 * actually gets to read and retry against. Models drift; tool boundaries should
 * absorb that rather than shatter on it.
 */
export const driveActionSchema = z.object({
  type: z.enum(ACTION_KINDS).optional().describe('Action to perform, e.g. "click".'),
  kind: z.enum(ACTION_KINDS).optional().describe("Alias for type."),
  selector: z.string().optional().describe("CSS selector the action targets."),
  text: z.string().optional().describe("Text to type, for type actions."),
  key: z.string().optional().describe('Key name, for key actions, e.g. "Escape".'),
  times: z.number().int().min(1).max(20).optional().describe("Repeat count for tab."),
  ms: z.number().int().min(0).max(2000).optional().describe("Delay for wait."),
});

export const findingSchema = z.object({
  kind: z.enum(["a11y", "perf", "correlation"]),
  severity: z.enum(["critical", "serious", "moderate", "minor"]),
  title: z.string().describe("Short, specific. Name the element and the defect."),
  detail: z.string().describe("What is wrong, for a developer. One or two sentences."),
  impact: z.string().describe("What this does to someone actually using the component."),
  anchor: z.string().nullable().describe("Selector the finding applies to, or null."),
  rootCause: z
    .object({ origin: z.string(), instanceCount: z.number().int().min(1) })
    .nullable()
    .describe("Set only when several instances share one source origin."),
  evidence: z
    .array(z.string())
    .describe("Quote the probe output that justifies this. Never assert without evidence."),
  caughtByAxe: z
    .boolean()
    .describe("True only if this exact issue appears in the axe violations you were given."),
});

export const TOOL_SCHEMAS = {
  drive: z.object({
    state: z.string().describe('Label for the state you are moving to, e.g. "modal open".'),
    actions: z.array(driveActionSchema).min(1).max(8),
  }),
  run_axe: z.object({}),
  read_transcript: z.object({}),
  trace_focus_order: z.object({}),
  snapshot_a11y_tree: z.object({}),
  apply_patch: z.object({
    source: z.string().describe("The complete patched component source. Not a diff."),
    rationale: z.string().describe("What you changed and why, briefly."),
  }),
  report_findings: z.object({
    findings: z.array(findingSchema),
    summary: z.string(),
  }),
} as const;

export const TOOL_DESCRIPTIONS: Record<keyof typeof TOOL_SCHEMAS, string> = {
  drive:
    "Move the component into a different interaction state by clicking, typing or " +
    "pressing keys, then re-probe. Use this to reach modals, error states, expanded " +
    "panels — anything not visible on first render. Most real defects live here.",
  run_axe:
    "Run axe-core against the current state. Returns mechanical WCAG violations. " +
    "It cannot judge whether a name is meaningful, only whether one exists.",
  read_transcript:
    "Get a linearised model of what a screen reader would announce for the current " +
    "state, with any names that look auto-generated or meaningless already flagged.",
  trace_focus_order:
    "Walk the keyboard focus order for the current state. Reports tab sequence, " +
    "positive-tabindex reordering, focus traps, modal containment, controls that " +
    "are mouse-only, and focusable elements hidden from assistive tech.",
  snapshot_a11y_tree:
    "Get the structured accessibility tree with roles, names, states and the " +
    "heading outline for the current state.",
  apply_patch:
    "Submit a complete corrected version of the component source. The patch is " +
    "re-mounted and every probe is re-run against it. The result you get back is " +
    "the verification verdict, including any regressions you introduced. A patch " +
    "that regresses anything is rejected and you must try again.",
  report_findings:
    "Report the final findings. Call this once, after verification, when you are done.",
};

export type ToolName = keyof typeof TOOL_SCHEMAS;

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];
