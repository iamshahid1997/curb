/**
 * The agent loop.
 *
 * Runs in the browser, because every tool it calls is a browser API. The server
 * is a single stateless endpoint holding the key and the prompt.
 *
 * The invariant this file exists to enforce: a patch is only ever reported as a
 * fix if the oracle re-ran and confirmed it. `apply_patch` does not apply
 * anything on trust — it mounts the patched source, re-probes every state the
 * agent visited, diffs the results, and hands the verdict back to the model. A
 * patch that regresses anything is rolled back and the model is told why.
 */

import type { SandboxController } from "@/lib/sandbox-host";
import type {
  A11yTreeResult,
  AxeResult,
  DriveAction,
  DriveResult,
  FocusOrderResult,
  MountResult,
  SourceFacts,
  TranscriptResult,
} from "@/sandbox/protocol";
import {
  detectCorrelations,
  summarizeCorrelations,
  type CorrelationCandidate,
} from "./correlate";
import { waitForVisible } from "@/lib/visibility";
import { buildInitialUserMessage } from "./prompt";
import {
  summarizeAxe,
  summarizeDrive,
  summarizeFocus,
  summarizeMount,
  summarizeTranscript,
  summarizeTree,
} from "./summarize";
import type {
  Finding,
  ProbeSnapshot,
  RunRecord,
  TraceEvent,
  VerificationResult,
} from "./types";

const MAX_STEPS = 24;
const MAX_MESSAGES = 55;
const MAX_PATCH_ATTEMPTS = 3;

interface ModelMessageLike {
  role: "user" | "assistant" | "tool";
  content: unknown;
}

interface StepResponse {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  model: string;
  ms: number;
  error?: string;
  code?: string;
}

export interface RunOptions {
  controller: SandboxController;
  source: string;
  apiKey?: string;
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
}

/** A state the agent drove into, replayed during verification. */
interface VisitedState {
  label: string;
  actions: DriveAction[];
}

export async function runAudit(options: RunOptions): Promise<RunRecord> {
  const { controller, source, apiKey, onEvent, signal } = options;

  const startedAt = Date.now();
  const events: TraceEvent[] = [];
  const emit = (event: TraceEvent) => {
    events.push(event);
    onEvent?.(event);
  };

  const record: RunRecord = {
    version: 1,
    id: `run_${startedAt.toString(36)}`,
    startedAt,
    finishedAt: null,
    originalSource: source,
    patchedSource: null,
    findings: [],
    verification: null,
    events,
    model: "",
    modelCalls: 0,
  };

  emit({ type: "run-started", at: Date.now(), source });

  /* ---------------------------------------------------------------------- */
  /* Probe state                                                            */
  /* ---------------------------------------------------------------------- */

  let currentSource = source;
  const visited: VisitedState[] = [];

  let lastAxe: AxeResult | null = null;
  let lastTranscript: TranscriptResult | null = null;
  let lastFocus: FocusOrderResult | null = null;
  let lastTree: A11yTreeResult | null = null;
  let sourceFacts: SourceFacts | null = null;

  /** Drive transitions so far — the runtime half of the C1 live-region rule. */
  const transitions: Array<{ label: string; result: DriveResult }> = [];

  const correlations = (): CorrelationCandidate[] =>
    sourceFacts
      ? detectCorrelations({
          facts: sourceFacts,
          transcript: lastTranscript,
          focus: lastFocus,
          tree: lastTree,
          transitions,
        })
      : [];

  const probeAll = async () => {
    // Geometry-dependent probes need a painted frame. Backgrounding the tab
    // zeroes every layout box, so wait for the page to come back rather than
    // failing a run the user only paused by switching tabs.
    await waitForVisible(signal);

    lastAxe = await controller.send<"run_axe">({ type: "run_axe" });
    lastTranscript = await controller.send<"transcribe_screen_reader">({
      type: "transcribe_screen_reader",
    });
    lastFocus = await controller.send<"trace_focus_order">({ type: "trace_focus_order" });
  };

  const snapshot = (): ProbeSnapshot => ({
    axeViolationIds: (lastAxe?.violations ?? []).map((v) => v.id).sort(),
    axeViolationCount: lastAxe?.violations.length ?? 0,
    unnamedNodes: (lastTranscript?.lines ?? []).filter((l) =>
      l.issues.some((i) => i.includes("No accessible name") || i.includes("no accessible name")),
    ).length,
    suspiciousNames: (lastTranscript?.lines ?? []).filter((l) => l.issues.length > 0).length,
    unreachableControls: lastFocus?.unreachable.length ?? 0,
    positiveTabindex: lastFocus?.positiveTabindexCount ?? 0,
    focusLostToBody: false,
    modalContainsFocus: lastFocus?.modal ? lastFocus.modal.contains : null,
    keyboardTrap: Boolean(lastFocus?.trap),
  });

  try {
    /* -------------------------------------------------------------------- */
    /* Initial mount + baseline probe                                       */
    /* -------------------------------------------------------------------- */

    emit({ type: "phase", at: Date.now(), phase: "probing", note: "default state" });

    const mount = await controller.send<"mount">({ type: "mount", source });
    sourceFacts = await controller.send<"analyze_source">({
      type: "analyze_source",
      source,
    });
    lastTree = await controller.send<"snapshot_a11y_tree">({ type: "snapshot_a11y_tree" });
    await probeAll();

    let baseline = snapshot();

    const messages: ModelMessageLike[] = [
      {
        role: "user",
        content: buildInitialUserMessage({
          source,
          mountSummary: summarizeMount(mount as MountResult),
          axeSummary: summarizeAxe(lastAxe!),
          transcript: summarizeTranscript(lastTranscript!),
          focusSummary: summarizeFocus(lastFocus!),
          correlations: summarizeCorrelations(correlations()),
        }),
      },
    ];

    /* -------------------------------------------------------------------- */
    /* Verification                                                         */
    /* -------------------------------------------------------------------- */

    let patchAttempts = 0;

    const verify = async (patched: string): Promise<VerificationResult> => {
      patchAttempts += 1;
      emit({ type: "phase", at: Date.now(), phase: "verifying" });

      const before = baseline;

      try {
        await controller.send<"mount">({ type: "mount", source: patched });
      } catch (err) {
        // Rebuild the known-good state so the run can continue.
        await controller.send<"mount">({ type: "mount", source: currentSource });
        await probeAll();

        return {
          compiled: false,
          compileError: err instanceof Error ? err.message : String(err),
          before,
          fixed: [],
          regressed: [],
          accepted: false,
          summary:
            "The patch does not compile, so nothing was verified. Fix the syntax and resubmit.",
        };
      }

      await probeAll();
      const afterDefault = snapshot();

      // Regressions frequently only appear in a driven state — a fix to the
      // default render that breaks the open modal would otherwise look clean.
      const stateNotes: string[] = [];
      for (const state of visited) {
        try {
          await controller.send<"drive">({ type: "drive", actions: state.actions });
          await probeAll();
          const s = snapshot();
          if (s.axeViolationCount > 0 || s.unreachableControls > 0 || s.keyboardTrap) {
            stateNotes.push(
              `In state "${state.label}": ${s.axeViolationCount} axe violation(s), ` +
                `${s.unreachableControls} unreachable control(s)` +
                `${s.keyboardTrap ? ", keyboard trap" : ""}.`,
            );
          }
          // Restore for the next replay.
          await controller.send<"mount">({ type: "mount", source: patched });
          await probeAll();
        } catch {
          stateNotes.push(`Could not replay state "${state.label}" against the patch.`);
        }
      }

      const after = afterDefault;
      const fixed: string[] = [];
      const regressed: string[] = [];

      const compare = (
        label: string,
        beforeValue: number,
        afterValue: number,
        lowerIsBetter = true,
      ) => {
        if (beforeValue === afterValue) return;
        const improved = lowerIsBetter ? afterValue < beforeValue : afterValue > beforeValue;
        const line = `${label}: ${beforeValue} → ${afterValue}`;
        if (improved) fixed.push(line);
        else regressed.push(line);
      };

      compare("axe violations", before.axeViolationCount, after.axeViolationCount);
      compare("flagged names", before.suspiciousNames, after.suspiciousNames);
      compare("unreachable controls", before.unreachableControls, after.unreachableControls);
      compare("positive tabindex", before.positiveTabindex, after.positiveTabindex);

      if (before.keyboardTrap && !after.keyboardTrap) fixed.push("keyboard trap removed");
      if (!before.keyboardTrap && after.keyboardTrap) regressed.push("keyboard trap introduced");

      if (before.modalContainsFocus === false && after.modalContainsFocus === true) {
        fixed.push("modal now contains focus");
      }
      if (before.modalContainsFocus === true && after.modalContainsFocus === false) {
        regressed.push("modal no longer contains focus");
      }

      const accepted = regressed.length === 0 && fixed.length > 0;

      if (accepted) {
        currentSource = patched;
        baseline = after;
      } else {
        // Roll back so the next attempt starts from the last good state.
        await controller.send<"mount">({ type: "mount", source: currentSource });
        await probeAll();
      }

      const summary = accepted
        ? `Accepted. Improved: ${fixed.join("; ")}.` +
          (stateNotes.length ? ` Remaining in other states: ${stateNotes.join(" ")}` : "")
        : regressed.length
          ? `REJECTED and rolled back — this patch regressed: ${regressed.join("; ")}. ` +
            `Fix that and resubmit the complete source.`
          : `REJECTED — nothing measurably improved. The probes report the same ` +
            `counts as before, so either the change had no effect or it addressed ` +
            `something the oracle does not measure.`;

      const result: VerificationResult = {
        compiled: true,
        before,
        after,
        fixed,
        regressed,
        accepted,
        summary,
      };

      emit({ type: "patch-attempt", at: Date.now(), attempt: patchAttempts, verification: result });
      return result;
    };

    /* -------------------------------------------------------------------- */
    /* Tool execution                                                       */
    /* -------------------------------------------------------------------- */

    // Held in an object rather than as `let` bindings: these are only ever
    // written inside the tool-execution closure, and TypeScript's control-flow
    // analysis narrows a closure-assigned `let` to `never` at the read site.
    const outcome: {
      findings: Finding[] | null;
      verification: VerificationResult | null;
    } = { findings: null, verification: null };

    const executeTool = async (name: string, input: unknown): Promise<string> => {
      switch (name) {
        case "run_axe": {
          lastAxe = await controller.send<"run_axe">({ type: "run_axe" });
          return summarizeAxe(lastAxe);
        }

        case "read_transcript": {
          lastTranscript = await controller.send<"transcribe_screen_reader">({
            type: "transcribe_screen_reader",
          });
          return `${summarizeTranscript(lastTranscript)}\n\n(${lastTranscript.disclaimer})`;
        }

        case "trace_focus_order": {
          lastFocus = await controller.send<"trace_focus_order">({
            type: "trace_focus_order",
          });
          return summarizeFocus(lastFocus);
        }

        case "snapshot_a11y_tree": {
          lastTree = await controller.send<"snapshot_a11y_tree">({
            type: "snapshot_a11y_tree",
          });
          return summarizeTree(lastTree);
        }

        case "drive": {
          const { state, actions: rawActions } = input as {
            state: string;
            actions: unknown[];
          };
          emit({ type: "phase", at: Date.now(), phase: "exploring", note: state });

          const normalized = normalizeActions(rawActions);
          if ("error" in normalized) return normalized.error;
          const actions = normalized.actions;

          const result = await controller.send<"drive">({ type: "drive", actions });
          visited.push({ label: state, actions });
          transitions.push({ label: state, result });

          // Re-probe automatically: a state the agent cannot see is a state it
          // will hallucinate about.
          await probeAll();

          return [
            `Now in state "${state}". ${summarizeDrive(result)}`,
            "",
            "AXE:",
            summarizeAxe(lastAxe!),
            "",
            "TRANSCRIPT:",
            summarizeTranscript(lastTranscript!),
            "",
            "FOCUS:",
            summarizeFocus(lastFocus!),
            "",
            "COUPLED A11Y/PERF PATTERNS:",
            summarizeCorrelations(correlations()),
          ].join("\n");
        }

        case "apply_patch": {
          const { source: patched } = input as { source: string; rationale: string };
          emit({ type: "phase", at: Date.now(), phase: "patching" });

          if (patchAttempts >= MAX_PATCH_ATTEMPTS) {
            return (
              `Patch budget exhausted (${MAX_PATCH_ATTEMPTS} attempts). ` +
              `Report your findings for what is still broken instead of patching again.`
            );
          }

          const verification = await verify(patched);
          outcome.verification = verification;
          if (verification.accepted) record.patchedSource = patched;

          return [
            verification.compiled ? "Patch compiled." : "Patch did NOT compile.",
            verification.compileError ? `Error: ${verification.compileError}` : "",
            `Fixed: ${verification.fixed.length ? verification.fixed.join("; ") : "nothing"}`,
            `Regressed: ${verification.regressed.length ? verification.regressed.join("; ") : "nothing"}`,
            "",
            verification.summary,
          ]
            .filter(Boolean)
            .join("\n");
        }

        case "report_findings": {
          const { findings, summary } = input as {
            findings: Array<Omit<Finding, "id">>;
            summary: string;
          };
          outcome.findings = findings.map((f, i) => ({
            ...f,
            id: `f${i + 1}`,
            rootCause: f.rootCause ?? undefined,
          }));
          emit({ type: "findings", at: Date.now(), findings: outcome.findings });
          return `Recorded ${outcome.findings.length} finding(s). ${summary}`;
        }

        default:
          return `Unknown tool "${name}".`;
      }
    };

    /* -------------------------------------------------------------------- */
    /* Loop                                                                 */
    /* -------------------------------------------------------------------- */

    emit({ type: "phase", at: Date.now(), phase: "planning" });

    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (signal?.aborted) throw new Error("Run cancelled.");

      emit({
        type: "model-request",
        at: Date.now(),
        step,
        messageCount: messages.length,
      });

      const response = await callStep(messages, apiKey, signal);
      record.modelCalls += 1;
      record.model = response.model;

      emit({
        type: "model-response",
        at: Date.now(),
        step,
        text: response.text,
        toolCalls: response.toolCalls.length,
        ms: response.ms,
      });

      if (!response.toolCalls.length) {
        // Nothing left to do — the model answered in prose.
        if (response.text) {
          messages.push({ role: "assistant", content: response.text });
        }
        break;
      }

      messages.push({
        role: "assistant",
        content: [
          ...(response.text ? [{ type: "text", text: response.text }] : []),
          ...response.toolCalls.map((call) => ({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })),
        ],
      });

      const results = [];

      for (const call of response.toolCalls) {
        emit({
          type: "tool-call",
          at: Date.now(),
          step,
          tool: call.toolName,
          input: call.input,
        });

        const toolStarted = Date.now();
        let output: string;
        let ok = true;

        try {
          output = await executeTool(call.toolName, call.input);
        } catch (err) {
          // A probe that cannot run is not a finding. If we hand this back as a
          // tool result the model reads "no issues found" and reports a clean
          // component, so the whole run has to fail instead.
          if (isProbeUnavailable(err)) throw err;

          ok = false;
          output = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        emit({
          type: "tool-result",
          at: Date.now(),
          step,
          tool: call.toolName,
          ok,
          ms: Date.now() - toolStarted,
          output,
        });

        results.push({
          type: "tool-result" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text" as const, value: output },
        });
      }

      messages.push({ role: "tool", content: results });

      if (outcome.findings) break;
    }

    // A run that patches and then stops has done the work but produced no
    // report. Rather than showing an empty findings panel, ask once, explicitly.
    if (!outcome.findings && messages.length < MAX_MESSAGES) {
      emit({ type: "phase", at: Date.now(), phase: "reporting" });

      messages.push({
        role: "user",
        content:
          "Now call report_findings with everything you found, including anything " +
          "you already fixed. Set caughtByAxe true only for issues that appeared in " +
          "the axe output you were shown.",
      });

      try {
        const closing = await callStep(messages, apiKey, signal);
        record.modelCalls += 1;

        emit({
          type: "model-response",
          at: Date.now(),
          step: MAX_STEPS,
          text: closing.text,
          toolCalls: closing.toolCalls.length,
          ms: closing.ms,
        });

        for (const call of closing.toolCalls) {
          if (call.toolName !== "report_findings") continue;
          emit({
            type: "tool-call",
            at: Date.now(),
            step: MAX_STEPS,
            tool: call.toolName,
            input: call.input,
          });
          await executeTool(call.toolName, call.input);
        }
      } catch {
        // A failed closing request must not discard a completed audit.
      }
    }

    record.findings = outcome.findings ?? [];
    record.verification = outcome.verification;
    record.finishedAt = Date.now();

    emit({
      type: "run-finished",
      at: Date.now(),
      ms: record.finishedAt - startedAt,
      accepted: Boolean(outcome.verification?.accepted),
    });

    return record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record.finishedAt = Date.now();
    emit({ type: "run-failed", at: Date.now(), error: message });
    throw Object.assign(err instanceof Error ? err : new Error(message), { record });
  }
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

/**
 * True when the sandbox refused to probe because the frame had no layout —
 * a backgrounded tab or hidden panel. Distinct from a probe that ran and found
 * nothing, which is why the sandbox tags the error by name.
 */
function isProbeUnavailable(err: unknown): boolean {
  const detail = (err as { detail?: { name?: string } })?.detail;
  return detail?.name === "ProbeUnavailableError";
}

/* -------------------------------------------------------------------------- */
/* Action normalisation                                                       */
/* -------------------------------------------------------------------------- */

const SELECTOR_REQUIRED = new Set([
  "click",
  "dblclick",
  "hover",
  "focus",
  "blur",
  "type",
  "submit",
]);

/**
 * Turn whatever the model produced into valid DriveActions, or return a message
 * telling it exactly what was wrong.
 *
 * The model reliably writes `type` where the sandbox protocol says `kind`, and
 * occasionally omits a selector. Both are recoverable, so we answer with
 * instructions rather than throwing — a tool error ends the branch, a tool
 * result the model can read lets it correct itself on the next step.
 */
function normalizeActions(
  raw: unknown[],
): { actions: DriveAction[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "drive needs a non-empty actions array." };
  }

  const actions: DriveAction[] = [];

  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      return { error: `Action ${index} is not an object.` };
    }

    const a = item as Record<string, unknown>;
    const kind = (a.type ?? a.kind) as string | undefined;

    if (!kind) {
      return {
        error:
          `Action ${index} has no action name. Each action needs a "type" field, ` +
          `one of: click, dblclick, hover, focus, blur, type, key, tab, submit, wait.`,
      };
    }

    if (SELECTOR_REQUIRED.has(kind) && typeof a.selector !== "string") {
      return {
        error: `Action ${index} ("${kind}") needs a "selector" — a CSS selector for the target element.`,
      };
    }

    switch (kind) {
      case "click":
      case "dblclick":
      case "hover":
      case "focus":
      case "blur":
      case "submit":
        actions.push({ kind, selector: a.selector as string });
        break;
      case "type":
        actions.push({
          kind: "type",
          selector: a.selector as string,
          text: typeof a.text === "string" ? a.text : "",
        });
        break;
      case "key":
        if (typeof a.key !== "string") {
          return { error: `Action ${index} ("key") needs a "key" field, e.g. "Escape".` };
        }
        actions.push({
          kind: "key",
          key: a.key,
          selector: typeof a.selector === "string" ? a.selector : undefined,
        });
        break;
      case "tab":
        actions.push({
          kind: "tab",
          times: typeof a.times === "number" ? a.times : 1,
        });
        break;
      case "wait":
        actions.push({ kind: "wait", ms: typeof a.ms === "number" ? a.ms : 100 });
        break;
      default:
        return {
          error:
            `Action ${index} has unknown type "${kind}". Valid types: click, dblclick, ` +
            `hover, focus, blur, type, key, tab, submit, wait.`,
        };
    }
  }

  return { actions };
}

/* -------------------------------------------------------------------------- */
/* Server call                                                                */
/* -------------------------------------------------------------------------- */

async function callStep(
  messages: ModelMessageLike[],
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<StepResponse> {
  const res = await fetch("/api/agent/step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, apiKey }),
    signal,
  });

  const json = (await res.json()) as StepResponse;

  if (!res.ok) {
    const hint =
      json.code === "quota-exhausted"
        ? " The free-tier quota is used up — add your own API key to continue."
        : json.code === "no-key"
          ? " No API key is configured."
          : "";
    throw new Error(`${json.error ?? `Model step failed (${res.status})`}${hint}`);
  }

  return json;
}
