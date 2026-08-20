/**
 * Two bundles, two very different environments.
 *
 * `probes.js` is injected verbatim into the page under audit, so it must be a
 * self-contained IIFE with no module semantics and no imports the page cannot
 * resolve.
 *
 * `index.js` is the Node CLI. Playwright stays external — it ships its own
 * browser binaries and must not be inlined.
 */

import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

const probes = await build({
  entryPoints: ["src/probes-entry.ts"],
  outfile: "dist/probes.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});

const cli = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  external: ["playwright"],
  banner: {
    // Some transitive deps of the AI SDK are CJS and call require() at load
    // time. In an ESM bundle esbuild replaces that with a shim that throws —
    // unless a real `require` is in scope, which the shim prefers when present.
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

if (probes.errors.length || cli.errors.length) process.exit(1);
console.log("[curb] built dist/probes.js and dist/index.js");
