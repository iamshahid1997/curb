/**
 * curb — audit a running app for accessibility and performance defects, and fix
 * them in source.
 *
 * Writes are opt-in. Running `curb` on a repository for the first time should
 * never modify it; `--fix` is the deliberate act. That default costs a flag and
 * removes the entire category of "the tool edited my code and I did not expect
 * it to".
 */

import { writeFileSync } from "node:fs";
import { relative } from "node:path";

import { runAudit, type AgentEvent, type AuditResult, type Finding } from "./agent.js";
import { PageDriver } from "./driver.js";
import {
  detectProject,
  discoverRoutes,
  findProjectRoot,
  startDevServer,
} from "./project.js";

/* -------------------------------------------------------------------------- */
/* Terminal styling                                                           */
/* -------------------------------------------------------------------------- */

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColour ? `[${code}m${s}[0m` : s);

const dim = paint("2");
const bold = paint("1");
const red = paint("31");
const yellow = paint("33");
const blue = paint("34");
const magenta = paint("35");
const green = paint("32");
const cyan = paint("36");

const SEVERITY_COLOUR: Record<Finding["severity"], (s: string) => string> = {
  critical: red,
  serious: yellow,
  moderate: magenta,
  minor: dim,
};

/* -------------------------------------------------------------------------- */
/* Args                                                                       */
/* -------------------------------------------------------------------------- */

interface Args {
  url?: string;
  port?: number;
  routes?: string[];
  fix: boolean;
  headed: boolean;
  json?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fix: false, headed: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];

    switch (arg) {
      case "--url": args.url = next(); break;
      case "--port": args.port = Number(next()); break;
      case "--routes": args.routes = next()?.split(",").map((r) => r.trim()).filter(Boolean); break;
      case "--fix": args.fix = true; break;
      case "--headed": args.headed = true; break;
      case "--json": args.json = next(); break;
      case "-h":
      case "--help": args.help = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return args;
}

const HELP = `
${bold("curb")} — audit a running app for accessibility and performance defects

  ${dim("$")} npx curb                    ${dim("audit, report, change nothing")}
  ${dim("$")} npx curb --fix              ${dim("also write verified patches to source")}

${bold("Options")}
  --url <url>        Audit a server already running here
  --port <n>         Port to start or look for the dev server on
  --routes /a,/b     Only these routes (default: discovered from the filesystem)
  --fix              Allow writing patches. Off by default.
  --headed           Show the browser while it works
  --json <path>      Write the full report as JSON
  -h, --help         This

${bold("Notes")}
  Needs GOOGLE_GENERATIVE_AI_API_KEY. Free key: https://aistudio.google.com/apikey
  Every patch is verified by re-probing every audited route. Anything that
  regresses is rolled back to the original file before you are told about it.
  Measurements come from the dev server and are inflated; treat them as relative.
`;

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "phase":
      process.stdout.write(
        `${dim("›")} ${cyan(event.phase)}${event.detail ? ` ${dim(event.detail)}` : ""}\n`,
      );
      return;

    case "route": {
      const v = event.probe.vitals;
      const violations = event.probe.axe.violations.reduce((n, x) => n + x.nodes.length, 0);
      process.stdout.write(
        `  ${bold(event.route)} ${dim(`· ${violations} axe · ${event.probe.focus.stops.length} tab stops · ` +
          `LCP ${v.lcp?.value ?? "?"}ms · CLS ${v.cls}`)}\n`,
      );
      return;
    }

    case "tool":
      if (event.name === "report_findings") return;
      process.stdout.write(`  ${dim("→")} ${dim(event.name)}\n`);
      return;

    case "patch":
      process.stdout.write(
        event.outcome.accepted
          ? `  ${green("✓")} patched ${bold(event.outcome.file)} ${dim(event.outcome.fixed.join("; "))}\n`
          : `  ${yellow("↺")} rolled back ${bold(event.outcome.file)} ${dim(event.outcome.summary.slice(0, 120))}\n`,
      );
      return;

    case "model":
      return;
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

function renderReport(result: AuditResult, args: Args): void {
  const { findings } = result;

  process.stdout.write(`\n${bold("Findings")}\n\n`);

  if (!findings.length) {
    process.stdout.write(`  ${green("No defects found.")}\n\n`);
    return;
  }

  const order: Finding["severity"][] = ["critical", "serious", "moderate", "minor"];
  const sorted = [...findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );

  for (const finding of sorted) {
    const colour = SEVERITY_COLOUR[finding.severity];
    const tags = [
      colour(finding.severity.toUpperCase()),
      finding.kind === "correlation" ? magenta("a11y×perf") : dim(finding.kind),
      finding.caughtByAxe ? dim("axe") : green("axe missed"),
      finding.fixed ? green("fixed") : "",
      finding.instances > 1 ? cyan(`${finding.instances}×`) : "",
    ].filter(Boolean);

    process.stdout.write(`  ${tags.join(" ")}  ${bold(finding.title)}\n`);

    if (finding.file) {
      process.stdout.write(
        `  ${dim(`${finding.file}${finding.line ? `:${finding.line}` : ""}`)}` +
          `${finding.route ? dim(`  on ${finding.route}`) : ""}\n`,
      );
    }

    process.stdout.write(`  ${finding.detail}\n`);
    process.stdout.write(`  ${dim(`Impact: ${finding.impact}`)}\n`);

    for (const line of finding.evidence.slice(0, 3)) {
      process.stdout.write(`    ${dim(`· ${line}`)}\n`);
    }

    process.stdout.write("\n");
  }

  const missed = findings.filter((f) => !f.caughtByAxe).length;
  const coupled = findings.filter((f) => f.kind === "correlation").length;
  const fixed = findings.filter((f) => f.fixed).length;

  process.stdout.write(`${bold("Summary")}\n`);
  process.stdout.write(
    `  ${findings.length} findings across ${result.routesAudited.length} route(s)\n` +
      `  ${missed} a rule engine would not have caught\n` +
      `  ${coupled} coupled accessibility/performance\n` +
      `  ${fixed} fixed and verified\n` +
      `  ${result.modelCalls} model calls (${result.model})\n`,
  );

  if (result.filesChanged.length) {
    process.stdout.write(
      `\n  ${green("Files changed:")} ${result.filesChanged.join(", ")}\n` +
        `  ${dim("Review with `git diff` before committing.")}\n`,
    );
  } else if (!args.fix) {
    process.stdout.write(`\n  ${dim("Dry run — nothing was written. Re-run with --fix to apply patches.")}\n`);
  }

  process.stdout.write("\n");
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      `${red("No API key.")} Set GOOGLE_GENERATIVE_AI_API_KEY.\n` +
        `Free key, no card: https://aistudio.google.com/apikey\n`,
    );
    return 1;
  }

  const root = findProjectRoot();
  const project = detectProject(root);

  process.stdout.write(
    `${bold("curb")} ${dim(`· ${relative(process.cwd(), root) || "."} · ${project.framework}`)}\n`,
  );
  if (!args.fix) process.stdout.write(`${dim("dry run — no files will be written")}\n`);
  process.stdout.write("\n");

  const server = await startDevServer({
    project,
    url: args.url,
    port: args.port,
    onLog: () => {},
  });

  let driver: PageDriver | null = null;

  try {
    const discovered = args.routes ?? (await discoverRoutes(project));
    const routes = discovered.slice(0, 8);

    process.stdout.write(
      `${dim(`${server.url} · ${routes.length} route(s): ${routes.join(", ")}`)}\n\n`,
    );

    driver = await PageDriver.launch({ projectRoot: root, headless: !args.headed });

    const result = await runAudit({
      driver,
      baseUrl: server.url,
      routes,
      projectRoot: root,
      apiKey,
      allowWrites: args.fix,
      onEvent: renderEvent,
    });

    renderReport(result, args);

    if (args.json) {
      writeFileSync(args.json, JSON.stringify(result, null, 2));
      process.stdout.write(`${dim(`Report written to ${args.json}`)}\n`);
    }

    // Non-zero when something critical is still outstanding, so CI can gate.
    const outstanding = result.findings.filter((f) => !f.fixed && f.severity === "critical");
    return outstanding.length ? 2 : 0;
  } finally {
    await driver?.close();
    await server.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`\n${red("curb failed:")} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
