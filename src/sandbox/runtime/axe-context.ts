/**
 * Re-entrant access to axe's virtual-DOM context.
 *
 * `axe.commons.*` reads from a cache that only exists between `axe.setup()` and
 * `axe.teardown()`, and calling setup twice throws:
 *
 *   Axe is already setup. Call `axe.teardown()` before calling `axe.setup` again.
 *
 * Two probes need that context — the accessibility tree and the focus tracer —
 * and each used to manage the lifecycle itself. That works only while callers
 * run them one at a time. The moment the playground refreshed its panels with
 * Promise.all, the two overlapped and the second setup threw.
 *
 * Reference counting fixes it at the right level: probes stop having to know
 * whether anyone else is mid-flight, and the context is torn down exactly once,
 * when the last holder releases it.
 */

import axe from "axe-core";

interface AxeLifecycle {
  setup(node: Node): void;
  teardown(): void;
}

let depth = 0;

/** Runs `fn` with axe's context available, nesting safely. */
export function withAxeContext<T>(fn: () => T): T {
  const lifecycle = axe as unknown as AxeLifecycle;

  if (depth === 0) {
    try {
      lifecycle.setup(document);
    } catch {
      // Another caller set it up outside this helper. Adopt it rather than
      // failing — but do not tear down what we did not create.
      depth += 1;
      return fn();
    }
  }

  depth += 1;

  try {
    return fn();
  } finally {
    depth -= 1;
    if (depth === 0) {
      try {
        lifecycle.teardown();
      } catch {
        /* already torn down; nothing to do */
      }
    }
  }
}
