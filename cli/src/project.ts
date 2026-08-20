/**
 * Understanding the project being audited: where it is, how to start it, and
 * which routes exist.
 *
 * Route discovery matters more than it looks. Auditing only "/" is barely
 * better than auditing one component — the defects that survive review are
 * usually on the settings page nobody opens, or in the state after a form
 * submits. Finding routes without being told is what makes `npx curb` a
 * single command rather than a configuration exercise.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type Framework = "next-app" | "next-pages" | "vite" | "cra" | "unknown";

export interface ProjectInfo {
  root: string;
  framework: Framework;
  devCommand: string | null;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  sourceDir: string;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

export function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`No package.json found from ${start} upwards.`);
}

export function detectProject(root: string): ProjectInfo {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const hasAppDir =
    existsSync(join(root, "app")) || existsSync(join(root, "src", "app"));
  const hasPagesDir =
    existsSync(join(root, "pages")) || existsSync(join(root, "src", "pages"));

  let framework: Framework = "unknown";
  if (deps.next) framework = hasAppDir ? "next-app" : hasPagesDir ? "next-pages" : "next-app";
  else if (deps.vite) framework = "vite";
  else if (deps["react-scripts"]) framework = "cra";

  const packageManager = existsSync(join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(root, "yarn.lock"))
      ? "yarn"
      : existsSync(join(root, "bun.lockb"))
        ? "bun"
        : "npm";

  const devScript = pkg.scripts?.dev ? "dev" : pkg.scripts?.start ? "start" : null;

  return {
    root,
    framework,
    devCommand: devScript,
    packageManager,
    sourceDir: existsSync(join(root, "src")) ? "src" : ".",
  };
}

/* -------------------------------------------------------------------------- */
/* Dev server                                                                 */
/* -------------------------------------------------------------------------- */

export interface DevServer {
  url: string;
  /** Null when we attached to a server that was already running. */
  process: ChildProcess | null;
  stop(): Promise<void>;
}

async function isUp(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Attach to a running dev server, or start one.
 *
 * Attaching is preferred and tried first: the developer usually already has the
 * app running, and starting a second copy would either fight for the port or
 * audit a different build than the one they are looking at.
 */
export async function startDevServer(options: {
  project: ProjectInfo;
  url?: string;
  port?: number;
  onLog?: (line: string) => void;
}): Promise<DevServer> {
  const { project, onLog } = options;

  const candidateUrls = options.url
    ? [options.url]
    : [
        ...(options.port ? [`http://localhost:${options.port}`] : []),
        "http://localhost:3000",
        "http://localhost:5173",
      ];

  for (const url of candidateUrls) {
    if (await isUp(url)) {
      onLog?.(`Attached to the dev server already running at ${url}`);
      return { url, process: null, stop: async () => {} };
    }
  }

  if (options.url) {
    throw new Error(`Nothing is responding at ${options.url}.`);
  }

  if (!project.devCommand) {
    throw new Error(
      `No "dev" or "start" script in package.json, and nothing is already running. ` +
        `Start your app and re-run with --url http://localhost:PORT`,
    );
  }

  const port = options.port ?? 3000;
  const runner = project.packageManager === "npm" ? "npm" : project.packageManager;
  const args = project.packageManager === "npm"
    ? ["run", project.devCommand]
    : ["run", project.devCommand];

  onLog?.(`Starting: ${runner} ${args.join(" ")} (port ${port})`);

  const child = spawn(runner, args, {
    cwd: project.root,
    env: { ...process.env, PORT: String(port), BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (buf: Buffer) => onLog?.(buf.toString().trimEnd()));
  child.stderr?.on("data", (buf: Buffer) => onLog?.(buf.toString().trimEnd()));

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Dev server exited with code ${child.exitCode} before becoming ready.`);
    }
    if (await isUp(url)) {
      onLog?.(`Dev server ready at ${url}`);
      return {
        url,
        process: child,
        stop: async () => {
          child.kill("SIGTERM");
          await new Promise((r) => setTimeout(r, 300));
          if (child.exitCode === null) child.kill("SIGKILL");
        },
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  child.kill("SIGKILL");
  throw new Error(`Dev server did not become ready at ${url} within 60s.`);
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/** Route segments that cannot be visited without knowing real parameter values. */
const DYNAMIC_SEGMENT = /^\[.+\]$/;
const ROUTE_GROUP = /^\(.+\)$/;

/**
 * Discover routes from the filesystem.
 *
 * Dynamic segments are skipped rather than guessed: visiting /users/[id] with a
 * made-up id usually renders a not-found page, and auditing a 404 while
 * reporting it as "/users/[id]" is worse than not auditing it.
 */
export async function discoverRoutes(project: ProjectInfo): Promise<string[]> {
  const routes = new Set<string>(["/"]);

  const appRoot = [
    join(project.root, "src", "app"),
    join(project.root, "app"),
  ].find((p) => existsSync(p));

  if (appRoot && project.framework === "next-app") {
    await walkAppDir(appRoot, appRoot, routes);
  }

  const pagesRoot = [
    join(project.root, "src", "pages"),
    join(project.root, "pages"),
  ].find((p) => existsSync(p));

  if (pagesRoot && project.framework === "next-pages") {
    await walkPagesDir(pagesRoot, pagesRoot, routes);
  }

  return Array.from(routes).sort();
}

async function walkAppDir(root: string, dir: string, out: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasPage = entries.some((e) => /^page\.(tsx|jsx|ts|js)$/.test(e.name));

  if (hasPage) {
    const rel = relative(root, dir);
    const segments = rel ? rel.split(sep) : [];

    // Route groups are organisational and contribute no URL segment.
    const visible = segments.filter((s) => !ROUTE_GROUP.test(s));

    if (!visible.some((s) => DYNAMIC_SEGMENT.test(s))) {
      out.add("/" + visible.join("/"));
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name === "api" || entry.name === "node_modules") {
      continue;
    }
    await walkAppDir(root, join(dir, entry.name), out);
  }
}

async function walkPagesDir(root: string, dir: string, out: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "api" || entry.name.startsWith("_")) continue;
      await walkPagesDir(root, full, out);
      continue;
    }

    if (!/\.(tsx|jsx|ts|js)$/.test(entry.name)) continue;
    if (entry.name.startsWith("_")) continue;

    const rel = relative(root, full).replace(/\.(tsx|jsx|ts|js)$/, "");
    const segments = rel.split(sep).filter((s) => s !== "index");
    if (segments.some((s) => DYNAMIC_SEGMENT.test(s))) continue;

    out.add("/" + segments.join("/"));
  }
}

/* -------------------------------------------------------------------------- */
/* Source files                                                               */
/* -------------------------------------------------------------------------- */

/** Paths outside the project are never read or written. */
function assertInsideProject(root: string, file: string): string {
  const full = resolve(root, file);
  const rel = relative(root, full);

  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Refusing to touch "${file}" — it is outside the project.`);
  }
  if (rel.split(sep).includes("node_modules")) {
    throw new Error(`Refusing to touch "${file}" — it is inside node_modules.`);
  }

  return full;
}

export async function readSourceFile(root: string, file: string): Promise<string> {
  return readFile(assertInsideProject(root, file), "utf8");
}

export async function writeSourceFile(
  root: string,
  file: string,
  contents: string,
): Promise<void> {
  await writeFile(assertInsideProject(root, file), contents, "utf8");
}

/** Keeps originals so a rejected patch can be rolled back exactly. */
export class FileBackup {
  private readonly originals = new Map<string, string>();

  constructor(private readonly root: string) {}

  remember(file: string, contents: string): void {
    if (!this.originals.has(file)) this.originals.set(file, contents);
  }

  restoreAll(): string[] {
    const restored: string[] = [];
    for (const [file, contents] of this.originals) {
      try {
        writeFileSync(assertInsideProject(this.root, file), contents, "utf8");
        restored.push(file);
      } catch {
        /* best effort; the caller reports what could not be restored */
      }
    }
    return restored;
  }

  get touched(): string[] {
    return Array.from(this.originals.keys());
  }
}
