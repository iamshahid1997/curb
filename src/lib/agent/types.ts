/**
 * Run types — the vocabulary the loop, the trace UI and the cassette recorder
 * all share.
 */

import type {
  AxeResult,
  DriveAction,
  DriveResult,
  FocusOrderResult,
  MountResult,
  TranscriptResult,
} from "@/sandbox/protocol";

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export type Severity = "critical" | "serious" | "moderate" | "minor";
export type FindingKind = "a11y" | "perf" | "correlation";

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  /** What is wrong, in one or two sentences, aimed at a developer. */
  detail: string;
  /** Why it matters to a person using the component. */
  impact: string;
  /** Selector or source location the finding anchors to. */
  anchor: string | null;
  /**
   * Set when several instances share one origin — "40 violations from
   * <Button>" is the finding, the instances are evidence.
   */
  rootCause?: { origin: string; instanceCount: number };
  /** Probe output that justifies the finding. Never model assertion alone. */
  evidence: string[];
  /** Whether a rule engine would have caught this. Drives the comparison UI. */
  caughtByAxe: boolean;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

export interface ProbeSnapshot {
  axeViolationIds: string[];
  axeViolationCount: number;
  unnamedNodes: number;
  suspiciousNames: number;
  unreachableControls: number;
  positiveTabindex: number;
  focusLostToBody: boolean;
  modalContainsFocus: boolean | null;
  keyboardTrap: boolean;
}

/**
 * The oracle's verdict on a patch. `apply_patch` returns this to the model, so
 * the model cannot claim success the probes did not confirm.
 */
export interface VerificationResult {
  compiled: boolean;
  compileError?: string;
  before: ProbeSnapshot;
  after?: ProbeSnapshot;
  /** Signals that improved. */
  fixed: string[];
  /** Signals that got worse — a patch causing any of these is rejected. */
  regressed: string[];
  /** Overall: did this patch make the component better without breaking it? */
  accepted: boolean;
  summary: string;
}

/* -------------------------------------------------------------------------- */
/* Trace                                                                      */
/* -------------------------------------------------------------------------- */

export type TraceEvent =
  | { type: "run-started"; at: number; source: string }
  | { type: "phase"; at: number; phase: RunPhase; note?: string }
  | { type: "model-request"; at: number; step: number; messageCount: number }
  | { type: "model-response"; at: number; step: number; text: string; toolCalls: number; ms: number }
  | { type: "tool-call"; at: number; step: number; tool: string; input: unknown }
  | { type: "tool-result"; at: number; step: number; tool: string; ok: boolean; ms: number; output: unknown }
  | { type: "patch-attempt"; at: number; attempt: number; verification: VerificationResult }
  | { type: "findings"; at: number; findings: Finding[] }
  | { type: "run-finished"; at: number; ms: number; accepted: boolean }
  | { type: "run-failed"; at: number; error: string };

export type RunPhase =
  | "planning"
  | "exploring"
  | "probing"
  | "diagnosing"
  | "patching"
  | "verifying"
  | "repairing"
  | "reporting";

/* -------------------------------------------------------------------------- */
/* Probe results bundle                                                       */
/* -------------------------------------------------------------------------- */

export interface StateProbe {
  /** Human label for the interaction state, e.g. "default", "modal open". */
  state: string;
  actions: DriveAction[];
  mount?: MountResult;
  drive?: DriveResult;
  axe?: AxeResult;
  transcript?: TranscriptResult;
  focus?: FocusOrderResult;
}

/* -------------------------------------------------------------------------- */
/* Run record (the cassette)                                                  */
/* -------------------------------------------------------------------------- */

export interface RunRecord {
  version: 1;
  id: string;
  startedAt: number;
  finishedAt: number | null;
  originalSource: string;
  patchedSource: string | null;
  findings: Finding[];
  verification: VerificationResult | null;
  events: TraceEvent[];
  model: string;
  /** Total model calls — the only part of a run that costs anything. */
  modelCalls: number;
}
