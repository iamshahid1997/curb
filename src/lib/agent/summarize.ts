/**
 * Probe output is verbose and the model pays for every token of it. These turn
 * raw results into compact prose that keeps the signal — element, defect,
 * evidence — and drops the parts the model cannot act on.
 */

import type {
  AxeResult,
  DriveResult,
  FocusOrderResult,
  MountResult,
  TranscriptResult,
  A11yTreeResult,
} from "@/sandbox/protocol";

export function summarizeMount(m: MountResult): string {
  const parts = [
    `Rendered <${m.componentName}> — ${m.nodeCount} nodes, ${m.renderMs}ms.`,
  ];
  if (m.exportInferred) {
    parts.push("(No default export declared; inferred from the last PascalCase declaration.)");
  }
  if (m.stubbedModules.length) {
    parts.push(
      `NOTE: these imports could not be resolved and were replaced with empty ` +
        `placeholder elements: ${m.stubbedModules.join(", ")}. Anything rendered by ` +
        `them is NOT the real markup, so do not report accessibility defects about ` +
        `those subtrees — you would be describing the placeholder, not the component.`,
    );
  }
  if (m.reactWarnings.length) {
    parts.push(`React warnings:\n${m.reactWarnings.map((w) => `  - ${w}`).join("\n")}`);
  }
  return parts.join("\n");
}

export function summarizeAxe(a: AxeResult): string {
  if (!a.violations.length) {
    return `No violations. (${a.passCount} checks passed.) Remember this only means nothing MECHANICAL failed.`;
  }

  return a.violations
    .map((v) => {
      const targets = v.nodes
        .slice(0, 4)
        .map((n) => `      ${n.target.join(" ")} — ${n.html.slice(0, 120)}`)
        .join("\n");
      const more = v.nodes.length > 4 ? `\n      …and ${v.nodes.length - 4} more` : "";
      return `  [${v.impact ?? "unknown"}] ${v.id}: ${v.help}\n${targets}${more}`;
    })
    .join("\n");
}

export function summarizeTranscript(t: TranscriptResult): string {
  const lines = t.lines
    .map((l) => {
      const flags = l.issues.length ? `   <-- ${l.issues.join("; ")}` : "";
      return `  ${l.text}${flags}`;
    })
    .join("\n");
  return lines || "  (nothing announced)";
}

export function summarizeFocus(f: FocusOrderResult): string {
  const out: string[] = [];

  if (f.stops.length) {
    out.push("  Tab order:");
    for (const s of f.stops) {
      const bits = [
        `${s.order}. ${s.selector ?? s.tag}`,
        `role=${s.role}`,
        `name=${s.name ? `"${s.name}"` : "(none)"}`,
      ];
      if (s.tabindex !== null) bits.push(`tabindex=${s.tabindex}`);
      if (s.reorderedByTabindex) bits.push("REORDERED by positive tabindex");
      if (s.ariaHidden) bits.push("inside aria-hidden");
      if (s.focusIndicator === "suppressed") bits.push("no visible focus indicator");
      out.push(`    ${bits.join(", ")}`);
    }
  } else {
    out.push("  Tab order: nothing focusable.");
  }

  if (f.unreachable.length) {
    out.push("  Interactive but unreachable by keyboard:");
    for (const u of f.unreachable) {
      out.push(`    ${u.selector ?? u.tag} ("${u.name}") — ${u.reason}`);
    }
  }

  if (f.modal) {
    out.push(
      `  Modal ${f.modal.selector ?? "(unknown)"}: focus ${
        f.modal.contains ? "is contained" : `ESCAPES to ${f.modal.escapes.length} outside element(s)`
      }`,
    );
  }

  if (f.trap) {
    out.push(`  KEYBOARD TRAP: cycles among ${f.trap.cycleLength} controls, no modal open.`);
  }

  if (f.notes.length) {
    out.push("  Notes:");
    for (const n of f.notes) out.push(`    - ${n}`);
  }

  return out.join("\n");
}

export function summarizeDrive(d: DriveResult): string {
  const out = [`Completed ${d.completed} action(s).`];
  out.push(
    d.focusLostToBody
      ? "Focus ended on <body> — it was not moved to the new content."
      : `Focus is on ${d.activeElement ?? "(unknown)"}.`,
  );
  if (d.liveRegionAnnouncements.length) {
    out.push(`Live region announced: ${d.liveRegionAnnouncements.join(" | ")}`);
  } else {
    out.push("No live-region announcements were observed during this transition.");
  }
  if (d.reactWarnings.length) {
    out.push(`React warnings: ${d.reactWarnings.join(" | ")}`);
  }
  return out.join(" ");
}

export function summarizeTree(t: A11yTreeResult): string {
  const out = [
    `${t.totals.nodes} nodes, ${t.totals.unnamed} unnamed, ` +
      `${t.totals.suspicious} with suspicious names, ${t.totals.landmarks} landmarks.`,
  ];
  if (t.headingOutline.length) {
    out.push("Heading outline:");
    for (const h of t.headingOutline) {
      out.push(`  ${"  ".repeat(Math.max(0, h.level - 1))}h${h.level}: ${h.text || "(empty)"}`);
    }
  } else {
    out.push("No headings.");
  }
  return out.join("\n");
}
