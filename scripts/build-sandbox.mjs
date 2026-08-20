/**
 * Bundles the sandbox runtime into `public/sandbox/runtime.js`.
 *
 * This cannot go through Next's build: the runtime is loaded as a classic
 * script by a document with an opaque origin, so it needs to be a single
 * self-contained IIFE with no module semantics and no CORS requirement.
 *
 * React is bundled in development mode on purpose. Its dev-mode warnings
 * (missing keys, invalid nesting, bad ARIA) are real probe signal that the
 * production build silently drops.
 */

import { build, context } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(root, "src/sandbox/runtime/index.ts")],
  outfile: resolve(root, "public/sandbox/runtime.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  // Always minified. The runtime is delivered to the sandbox as a string and
  // evaluated there, so its size is not just download cost — it is parse-and-
  // eval cost on every sandbox rebuild. Unminified this is 7.2MB and stalls the
  // renderer; minified it is ~3.3MB.
  minify: true,
  sourcemap: watch ? "inline" : false,
  // Keep React's development build even though we minify: its warnings are
  // probe input, and they survive minification because they are string literals.
  define: { "process.env.NODE_ENV": '"development"' },
  legalComments: "none",
  logLevel: "info",
};

await mkdir(resolve(root, "public/sandbox"), { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[sandbox] watching for changes…");
} else {
  const result = await build(options);
  if (result.errors.length) process.exit(1);
  console.log("[sandbox] built public/sandbox/runtime.js");
}
