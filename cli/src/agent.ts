/**
 * The CLI agent loop.
 *
 * Same invariant as the web version, applied to real files: `patch_file` does
 * not report success on trust. It writes, waits for the dev server to reload,
 * re-probes every route that has been audited so far, and compares. A patch
 * that regresses anything is restored byte-for-byte from a backup taken before
 * the write, and the model is told exactly what it broke.
 *
 * The consequence of getting that wrong is larger here than in the browser
 * version — this edits a repository — so rollback is unconditional and happens
 * before the verdict is even reported.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool, type ModelMessage } from "ai";
import { z } from "zod";

import type { PageDriver, PageProbe } from "./driver.js";
import { detectLiveCorrelations, summarizeLiveCorrelations } from "./correlate-live.js";
import { buildPageMessage, SYSTEM_PROMPT } from "./prompt.js";
import { FileBackup, readSourceFile, writeSourceFile } from "./project.js";
import type { SourceLocation } from "./source-map.js";

// The SDK's warning logger writes multi-line advisories to stderr mid-run,
// which buries the progress output. Warnings we care about are surfaced
// deliberately instead.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const MODEL_CHAIN = process.env.CURB_MODEL
  ? [process.env.CURB_MODEL]
  : ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"];

const MAX_STEPS = 30;
const MAX_PATCHES = 6;

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface Finding {
  id: string;
  kind: "a11y" | "perf" | "correlation";
  severity: "critical" | "serious" | "moderate" | "minor";
  title: string;
  detail: string;
  impact: string;
  route: string | null;
  file: string | null;
  line: number | null;
  instances: number;
  evidence: string[];
  caughtByAxe: boolean;
  fixed: boolean;
}

export interface RouteSnapshot {
  route: string;
  axeViolations: number;
  axeIds: string[];
  flaggedNames: number;
  unreachable: number;
  positiveTabindex: number;
}

export interface PatchOutcome {
  file: string;
  accepted: boolean;
  fixed: string[];
  regressed: string[];
  summary: string;
}

export interface AuditResult {
  findings: Finding[];
  patches: PatchOutcome[];
  routesAudited: string[];
  modelCalls: number;
  model: string;
  filesChanged: string[];
}

export type AgentEvent =
  | { type: "phase"; phase: string; detail?: string }
  | { type: "route"; route: string; probe: PageProbe }
  | { type: "tool"; name: string; input: unknown }
  | { type: "patch"; outcome: PatchOutcome }
  | { type: "model"; step: number; ms: number; toolCalls: number; text: string };

/* -------------------------------------------------------------------------- */
/* Tool schemas                                                               */
/* -------------------------------------------------------------------------- */

const actionSchema = z.object({
  kind: z.enum(["click", "hover", "focus", "type", "key", "tab", "wait", "scroll"]),
  selector: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  times: z.number().int().min(1).max(30).optional(),
  ms: z.number().int().min(0).max(3000).optional(),
});

const findingSchema = z.object({
  kind: z.enum(["a11y", "perf", "correlation"]),
  severity: z.enum(["critical", "serious", "moderate", "minor"]),
  title: z.string(),
  detail: z.string(),
  impact: z.string(),
  route: z.string().nullable(),
  file: z.string().nullable().describe("Source file, when the element resolved to one."),
  line: z.number().nullable(),
  instances: z.number().int().min(1).describe("How many elements share this root cause."),
  evidence: z.array(z.string()),
  caughtByAxe: z.boolean(),
  fixed: z.boolean().describe("True only if you patched it and the patch was accepted."),
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export interface AuditOptions {
  driver: PageDriver;
  baseUrl: string;
  routes: string[];
  projectRoot: string;
  apiKey: string;
  allowWrites: boolean;
  onEvent?: (event: AgentEvent) => void;
}

export async function runAudit(options: AuditOptions): Promise<AuditResult> {
  const { driver, baseUrl, routes, projectRoot, apiKey, allowWrites, onEvent } = options;

  const google = createGoogleGenerativeAI({ apiKey });
  const backup = new FileBackup(projectRoot);

  const messages: ModelMessage[] = [];
  const snapshots = new Map<string, RouteSnapshot>();
  const sourceText = new Map<string, string>();
  const sourceLocations = new Map<string, SourceLocation>();
  const transitions: Array<{ label: string; announcements: string[] }> = [];
  const patches: PatchOutcome[] = [];

  let findings: Finding[] | null = null;
  let modelCalls = 0;
  let modelUsed = "";
  let patchCount = 0;

  /* ---------------------------------------------------------------------- */
  /* Probing                                                                */
  /* ---------------------------------------------------------------------- */

  const snapshotOf = (route: string, probe: PageProbe): RouteSnapshot => ({
    route,
    axeViolations: probe.axe.violations.reduce((n, v) => n + v.nodes.length, 0),
    axeIds: probe.axe.violations.map((v) => v.id).sort(),
    flaggedNames: probe.transcript.lines.filter((l) => l.issues.length).length,
    unreachable: probe.focus.unreachable.length,
    positiveTabindex: probe.focus.positiveTabindexCount,
  });

  const probeRoute = async (route: string): Promise<{ probe: PageProbe; message: string }> => {
    onEvent?.({ type: "phase", phase: "probing", detail: route });

    await driver.visit(new URL(route, baseUrl).href);
    const probe = await driver.probe();

    const selectors = await driver.interestingSelectors();
    const sources = await driver.resolveSources(selectors);
    for (const [selector, location] of sources) sourceLocations.set(selector, location);

    // Load the files behind this page once; correlation rules need their text.
    for (const location of sources.values()) {
      if (sourceText.has(location.file)) continue;
      try {
        sourceText.set(location.file, await readSourceFile(projectRoot, location.file));
      } catch {
        /* generated or out-of-tree file; skip */
      }
    }

    snapshots.set(route, snapshotOf(route, probe));
    onEvent?.({ type: "route", route, probe });

    const correlations = detectLiveCorrelations({ probe, sources, sourceText, transitions });

    const message = buildPageMessage({
      route,
      title: probe.title,
      mountNote: probe.consoleErrors.length
        ? `Console errors: ${probe.consoleErrors.slice(0, 3).join(" | ")}`
        : "No console errors.",
      axe: formatAxe(probe),
      transcript: formatTranscript(probe),
      focus: formatFocus(probe),
      vitals: formatVitals(probe),
      correlations: summarizeLiveCorrelations(correlations),
      sources: formatSources(sources),
      isFirst: messages.length === 0,
    });

    return { probe, message };
  };

  /* ---------------------------------------------------------------------- */
  /* Verification                                                           */
  /* ---------------------------------------------------------------------- */

  const verifyPatch = async (file: string): Promise<PatchOutcome> => {
    onEvent?.({ type: "phase", phase: "verifying", detail: file });

    const before = new Map(snapshots);
    const fixed: string[] = [];
    const regressed: string[] = [];

    // Re-probe every route audited so far: a fix on one page routinely breaks
    // another when the file is shared.
    for (const route of before.keys()) {
      try {
        await driver.visit(new URL(route, baseUrl).href);
        const probe = await driver.probe();
        const after = snapshotOf(route, probe);
        const prior = before.get(route)!;

        const compare = (label: string, a: number, b: number) => {
          if (a === b) return;
          const line = `${route} ${label}: ${a} → ${b}`;
          (b < a ? fixed : regressed).push(line);
        };

        compare("axe violations", prior.axeViolations, after.axeViolations);
        compare("flagged names", prior.flaggedNames, after.flaggedNames);
        compare("unreachable controls", prior.unreachable, after.unreachable);
        compare("positive tabindex", prior.positiveTabindex, after.positiveTabindex);

        if (probe.consoleErrors.length) {
          regressed.push(`${route}: ${probe.consoleErrors.length} console error(s) after the patch`);
        }

        snapshots.set(route, after);
      } catch (err) {
        regressed.push(
          `${route} failed to load after the patch: ${
            err instanceof Error ? err.message.split("\n")[0] : String(err)
          }`,
        );
      }
    }

    const accepted = regressed.length === 0 && fixed.length > 0;

    if (!accepted) {
      backup.restoreAll();
      // Restore the pre-patch snapshots so the next attempt starts clean.
      for (const [route, snap] of before) snapshots.set(route, snap);
      await new Promise((r) => setTimeout(r, 800));
    }

    const summary = accepted
      ? `Accepted. ${fixed.join("; ")}`
      : regressed.length
        ? `REJECTED and rolled back — this regressed: ${regressed.join("; ")}. The file is back to its original contents.`
        : `REJECTED — nothing measurably improved, so the change was reverted. Either it had no effect, or it addressed something the oracle does not measure.`;

    const outcome: PatchOutcome = { file, accepted, fixed, regressed, summary };
    patches.push(outcome);
    onEvent?.({ type: "patch", outcome });
    return outcome;
  };

  /* ---------------------------------------------------------------------- */
  /* Tools                                                                  */
  /* ---------------------------------------------------------------------- */

  const readFiles = new Set<string>();

  const executeTool = async (name: string, input: unknown): Promise<string> => {
    onEvent?.({ type: "tool", name, input });

    switch (name) {
      case "visit_route": {
        const { route } = input as { route: string };
        if (!routes.includes(route) && !route.startsWith("/")) {
          return `"${route}" is not a route. Known routes: ${routes.join(", ")}`;
        }
        const { message } = await probeRoute(route);
        return message;
      }

      case "drive": {
        const { state, actions } = input as {
          state: string;
          actions: Array<Record<string, unknown>>;
        };
        onEvent?.({ type: "phase", phase: "exploring", detail: state });

        const outcome = await driver.drive(actions as never);
        transitions.push({ label: state, announcements: outcome.announcements });

        const probe = await driver.probe();
        const route = new URL(driver.currentUrl).pathname;
        snapshots.set(route, snapshotOf(route, probe));

        const parts = [
          `State "${state}": ${outcome.completed} action(s) completed.`,
          outcome.failed ? `FAILED: ${outcome.failed}` : "",
          outcome.focusLostToBody
            ? "Focus ended on <body> — it was not moved to the new content."
            : `Focus is on ${outcome.activeElement ?? "(unknown)"}.`,
          outcome.announcements.length
            ? `Announced: ${outcome.announcements.join(" | ")}`
            : "No live-region announcement was observed during this transition.",
          "",
          "AXE:",
          formatAxe(probe),
          "",
          "KEYBOARD:",
          formatFocus(probe),
        ];

        return parts.filter(Boolean).join("\n");
      }

      case "read_file": {
        const { path } = input as { path: string };
        try {
          const text = await readSourceFile(projectRoot, path);
          readFiles.add(path);
          sourceText.set(path, text);
          const numbered = text
            .split("\n")
            .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
            .join("\n");
          return `${path} (${text.split("\n").length} lines)\n\n${numbered.slice(0, 20000)}`;
        } catch (err) {
          return `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "patch_file": {
        const { path, contents, rationale } = input as {
          path: string;
          contents: string;
          rationale: string;
        };

        if (!allowWrites) {
          return (
            `Dry run — no files are being written. Record this as a finding instead, ` +
            `describing the fix in words. Rationale noted: ${rationale}`
          );
        }
        if (!readFiles.has(path)) {
          return `Read ${path} first. Patching a file you have not read this run is not allowed.`;
        }
        if (patchCount >= MAX_PATCHES) {
          return `Patch budget of ${MAX_PATCHES} is exhausted. Report the rest as findings.`;
        }

        patchCount += 1;
        onEvent?.({ type: "phase", phase: "patching", detail: path });

        try {
          const original = await readSourceFile(projectRoot, path);
          backup.remember(path, original);
          await writeSourceFile(projectRoot, path, contents);
        } catch (err) {
          return `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Give the dev server time to compile before re-probing.
        await new Promise((r) => setTimeout(r, 1500));

        const outcome = await verifyPatch(path);
        return outcome.summary;
      }

      case "report_findings": {
        const { findings: reported, summary } = input as {
          findings: Array<Omit<Finding, "id">>;
          summary: string;
        };
        findings = reported.map((f, i) => ({ ...f, id: `f${i + 1}` }));
        return `Recorded ${findings.length} finding(s). ${summary}`;
      }

      default:
        return `Unknown tool "${name}".`;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Loop                                                                   */
  /* ---------------------------------------------------------------------- */

  const tools = {
    visit_route: tool({
      description: `Navigate to a route and probe it. Available routes: ${routes.join(", ")}`,
      inputSchema: z.object({ route: z.string() }),
    }),
    drive: tool({
      description:
        "Interact with the current page to reach a different state — open a dialog, submit a form, expand a panel — then re-probe. Most real defects only appear here.",
      inputSchema: z.object({ state: z.string(), actions: z.array(actionSchema).min(1).max(8) }),
    }),
    read_file: tool({
      description: "Read a source file, relative to the project root. Required before patching it.",
      inputSchema: z.object({ path: z.string() }),
    }),
    patch_file: tool({
      description:
        "Write the complete new contents of a source file. It is applied, the dev server reloads, every audited route is re-probed, and you get the verdict. A patch that regresses anything is rolled back automatically.",
      inputSchema: z.object({
        path: z.string(),
        contents: z.string(),
        rationale: z.string(),
      }),
    }),
    report_findings: tool({
      description: "Report all findings. Call once, at the end.",
      inputSchema: z.object({ findings: z.array(findingSchema), summary: z.string() }),
    }),
  };

  const callModel = async (step: number) => {
    let lastError = "";

    for (const modelId of MODEL_CHAIN) {
      try {
        const started = Date.now();
        const result = await generateText({
          model: google(modelId),
          system: SYSTEM_PROMPT,
          messages,
          tools,
          maxRetries: 1,
        });

        modelUsed = modelId;
        modelCalls += 1;
        onEvent?.({
          type: "model",
          step,
          ms: Date.now() - started,
          toolCalls: result.toolCalls.length,
          text: result.text,
        });
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Quota is metered per model, so try the next one.
        if (!/quota|RESOURCE_EXHAUSTED|429|503|high demand|not found|404/i.test(lastError)) break;
      }
    }

    throw new Error(lastError || "Every model in the chain failed.");
  };

  // Seed with the first route.
  const first = await probeRoute(routes[0] ?? "/");
  messages.push({ role: "user", content: first.message });

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await callModel(step);

    if (!result.toolCalls.length) {
      if (result.text) messages.push({ role: "assistant", content: result.text });
      break;
    }

    // Append the SDK's own message objects rather than rebuilding them from
    // toolCalls. Gemini 3 attaches a thoughtSignature to each function call in
    // providerOptions, and a hand-built message silently drops it — the SDK
    // then has to inject a skip-validation sentinel on every subsequent
    // request to avoid an HTTP 400. Passing its messages through keeps the
    // provider metadata intact.
    messages.push(...result.response.messages);

    const results = [];
    for (const call of result.toolCalls) {
      let output: string;
      try {
        output = await executeTool(call.toolName, call.input);
      } catch (err) {
        output = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text" as const, value: output },
      });
    }

    messages.push({ role: "tool", content: results });
    if (findings) break;
  }

  // A run that audits and patches but never reports has done the work and shown
  // nothing. Ask once, explicitly.
  if (!findings) {
    onEvent?.({ type: "phase", phase: "reporting" });
    messages.push({
      role: "user",
      content:
        "Now call report_findings with everything you found, including anything you " +
        "already fixed. Set caughtByAxe true only for issues that appeared in the axe " +
        "output you were shown.",
    });

    try {
      const closing = await callModel(MAX_STEPS);
      for (const call of closing.toolCalls) {
        if (call.toolName === "report_findings") await executeTool(call.toolName, call.input);
      }
    } catch {
      /* a failed closing request must not discard a completed audit */
    }
  }

  return {
    findings: findings ?? [],
    patches,
    routesAudited: Array.from(snapshots.keys()),
    modelCalls,
    model: modelUsed,
    filesChanged: patches.filter((p) => p.accepted).map((p) => p.file),
  };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function formatAxe(probe: PageProbe): string {
  if (!probe.axe.violations.length) {
    return `  None. (${probe.axe.passCount} checks passed — this only means nothing MECHANICAL failed.)`;
  }
  return probe.axe.violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 3)
        .map((n) => `      ${n.target.join(" ")} — ${n.html.slice(0, 110)}`)
        .join("\n");
      const more = v.nodes.length > 3 ? `\n      …and ${v.nodes.length - 3} more` : "";
      return `  [${v.impact}] ${v.id}: ${v.help}\n${nodes}${more}`;
    })
    .join("\n");
}

function formatTranscript(probe: PageProbe): string {
  const lines = probe.transcript.lines.slice(0, 40).map((l) => {
    const flags = l.issues.length ? `   <-- ${l.issues.join("; ")}` : "";
    return `  ${l.text}${flags}`;
  });
  if (probe.transcript.lines.length > 40) lines.push(`  …${probe.transcript.lines.length - 40} more`);
  return lines.join("\n") || "  (nothing announced)";
}

function formatFocus(probe: PageProbe): string {
  const out: string[] = [];
  const stops = probe.focus.stops as Array<Record<string, unknown>>;

  out.push(`  ${stops.length} tab stop(s).`);

  const unnamed = stops.filter((s) => !s.name);
  if (unnamed.length) out.push(`  ${unnamed.length} with no accessible name.`);

  for (const item of probe.focus.unreachable as Array<Record<string, unknown>>) {
    out.push(`  UNREACHABLE: ${item.selector} ("${item.name}") — ${item.reason}`);
  }

  for (const note of probe.focus.notes) out.push(`  ${note}`);

  return out.join("\n");
}

function formatVitals(probe: PageProbe): string {
  const v = probe.vitals;
  const out = [
    `  TTFB ${v.ttfb}ms · FCP ${v.firstContentfulPaint}ms · CLS ${v.cls}`,
    `  ${v.resourceCount} requests, ${(v.transferBytes / 1024).toFixed(0)}KB transferred`,
  ];
  if (v.lcp) {
    out.push(
      `  LCP ${v.lcp.value}ms on <${v.lcp.element ?? "?"}>` +
        (v.lcp.loadingAttr ? ` (loading="${v.lcp.loadingAttr}")` : ""),
    );
  }
  const long = v.longTasks.filter((t) => t.duration > 50);
  if (long.length) {
    out.push(`  ${long.length} long task(s), longest ${Math.max(...long.map((t) => t.duration))}ms`);
  }
  return out.join("\n");
}

function formatSources(sources: Map<string, SourceLocation>): string {
  if (!sources.size) return "  (none resolved)";

  const byOrigin = new Map<string, string[]>();
  for (const [selector, loc] of sources) {
    const key = `${loc.file}:${loc.line}`;
    byOrigin.set(key, [...(byOrigin.get(key) ?? []), selector]);
  }

  return Array.from(byOrigin)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([origin, selectors]) =>
      selectors.length > 1
        ? `  ${origin}  <- ${selectors.length} elements (SHARED ORIGIN — one root cause)`
        : `  ${origin}  <- ${selectors[0]}`,
    )
    .join("\n");
}
