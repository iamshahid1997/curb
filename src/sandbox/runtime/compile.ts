/**
 * Turns pasted JSX/TSX source into a mountable React component, inside the
 * sandbox.
 *
 * Two problems worth naming:
 *
 * 1. People paste fragments, not modules. `function Card() { ... }` with no
 *    export is the common case. We infer the export rather than rejecting it.
 * 2. Pasted code imports things we cannot supply (`lucide-react`, `@/lib/utils`).
 *    Those resolve to placeholder components rather than failing the mount, so
 *    Curb works on real code and not only self-contained snippets. Which
 *    modules were stubbed is reported up to the agent — see createRequire.
 */

import * as Babel from "@babel/standalone";
import * as React from "react";
import type { CompileDiagnostic } from "../protocol";

export class CompileError extends Error {
  diagnostics: CompileDiagnostic[];
  constructor(message: string, diagnostics: CompileDiagnostic[] = []) {
    super(message);
    this.name = "CompileError";
    this.diagnostics = diagnostics;
  }
}

export interface CompileOutput {
  Component: React.ComponentType<Record<string, unknown>>;
  componentName: string;
  exportInferred: boolean;
  /** Module ids replaced with placeholders. Reported, never hidden. */
  stubbedModules: string[];
}

/**
 * Modules available to pasted code.
 *
 * Real components import icons, utilities and design-system primitives. Failing
 * the whole mount on the first unresolvable import would restrict Curb to
 * self-contained snippets, so unknown modules resolve to placeholder components
 * instead.
 *
 * The trade-off is real and must not be hidden: a stubbed icon renders as an
 * empty inline span, so it carries none of the original's markup or ARIA. Any
 * finding about a stubbed element could be an artefact of the stub. Every
 * stubbed module id is recorded and reported up through MountResult so the
 * agent is told plainly which parts of the tree are not the real thing.
 */
function createRequire(stubbed: Set<string>): (id: string) => unknown {
  const registry: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": React,
    "react/jsx-dev-runtime": React,
  };

  /** Renders nothing but its children, so layout and text survive. */
  const Placeholder = React.forwardRef<HTMLSpanElement, Record<string, unknown>>(
    function CurbStub(props, ref) {
      const { children, ...rest } = props as { children?: React.ReactNode };
      // Pass through aria-*/role/className so a stub cannot mask a real defect
      // by silently dropping the attributes the component set on it.
      const safe: Record<string, unknown> = { ref, "data-curb-stub": "true" };
      for (const [key, value] of Object.entries(rest)) {
        if (/^(aria-|data-|role$|class|id$|title$|tabIndex$)/i.test(key)) safe[key] = value;
      }
      return React.createElement("span", safe, children ?? null);
    },
  );

  return (id: string) => {
    if (id in registry) return registry[id];

    stubbed.add(id);

    // Any named export becomes the same placeholder component.
    return new Proxy(
      { __esModule: true, default: Placeholder },
      {
        get(target, prop) {
          if (prop === "__esModule") return true;
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
          if (typeof prop === "symbol") return undefined;
          return Placeholder;
        },
      },
    );
  };
}

/**
 * Babel plugin: if the file declares no default export, add one pointing at the
 * last top-level PascalCase function or variable. That is nearly always the
 * component someone meant to paste.
 */
function inferDefaultExportPlugin(state: { inferredName: string | null }) {
  return function plugin({ types: t }: { types: typeof import("@babel/types") }) {
    return {
      visitor: {
        Program(path: {
          node: { body: unknown[] };
          pushContainer: (key: string, node: unknown) => void;
        }) {
          const body = path.node.body as Array<Record<string, unknown>>;

          const hasDefault = body.some((n) => n.type === "ExportDefaultDeclaration");
          if (hasDefault) return;

          let candidate: string | null = null;

          for (const node of body) {
            const inner =
              node.type === "ExportNamedDeclaration" && node.declaration
                ? (node.declaration as Record<string, unknown>)
                : node;

            if (inner.type === "FunctionDeclaration") {
              const name = (inner.id as { name?: string } | null)?.name;
              if (name && /^[A-Z]/.test(name)) candidate = name;
            }

            if (inner.type === "VariableDeclaration") {
              for (const decl of inner.declarations as Array<Record<string, unknown>>) {
                const id = decl.id as { type?: string; name?: string };
                if (id?.type !== "Identifier" || !id.name) continue;
                if (!/^[A-Z]/.test(id.name)) continue;
                const init = decl.init as { type?: string } | null;
                const isFn =
                  init?.type === "ArrowFunctionExpression" ||
                  init?.type === "FunctionExpression" ||
                  init?.type === "CallExpression"; // memo(...), forwardRef(...)
                if (isFn) candidate = id.name;
              }
            }
          }

          if (!candidate) return;
          state.inferredName = candidate;
          path.pushContainer(
            "body",
            t.exportDefaultDeclaration(t.identifier(candidate)),
          );
        },
      },
    };
  };
}

export function compile(source: string): CompileOutput {
  if (!source.trim()) {
    throw new CompileError("Nothing to compile — the source is empty.");
  }

  const inference = { inferredName: null as string | null };

  let code: string;
  try {
    const result = Babel.transform(source, {
      filename: "Component.tsx",
      sourceType: "module",
      // Babel 8 removed allExtensions/isTSX; the .tsx filename drives TSX
      // detection instead.
      presets: [["react", { runtime: "classic" }], "typescript"],
      plugins: [
        inferDefaultExportPlugin(inference),
        "transform-modules-commonjs",
      ],
      // Keep output readable; we surface it in the diff viewer on failure.
      compact: false,
    });
    code = result?.code ?? "";
  } catch (err) {
    const e = err as Error & { loc?: { line: number; column: number } };
    throw new CompileError(e.message, [
      { message: e.message, line: e.loc?.line, column: e.loc?.column },
    ]);
  }

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const stubbed = new Set<string>();

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function("React", "require", "module", "exports", code);
    factory(React, createRequire(stubbed), moduleObj, moduleObj.exports);
  } catch (err) {
    if (err instanceof CompileError) throw err;
    const e = err as Error;
    throw new CompileError(`Evaluating the component threw: ${e.message}`, [
      { message: e.message },
    ]);
  }

  const exported = moduleObj.exports.default;

  if (typeof exported !== "function" && typeof exported !== "object") {
    throw new CompileError(
      "No component found. Paste a function component, or add a default export.",
    );
  }

  const Component = exported as React.ComponentType<Record<string, unknown>>;
  const componentName =
    inference.inferredName ??
    (Component as { displayName?: string; name?: string }).displayName ??
    (Component as { name?: string }).name ??
    "Component";

  return {
    Component,
    componentName,
    exportInferred: inference.inferredName !== null,
    stubbedModules: Array.from(stubbed),
  };
}
