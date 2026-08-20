/**
 * Waiting for a painted document.
 *
 * A hidden document has no layout: every getBoundingClientRect returns 0x0,
 * including for elements that are perfectly visible once the tab is
 * foregrounded. Probing in that state produces false negatives rather than
 * errors, so the sandbox refuses outright — and callers wait here instead of
 * failing work the user only paused by switching tabs.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

export function waitForVisible(
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onChange);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };

    const onChange = () => {
      if (document.visibilityState === "visible") {
        cleanup();
        resolve();
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Cancelled while waiting for the page to become visible."));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "The page stayed hidden for two minutes, so this was stopped. Probes that " +
            "depend on layout cannot run in a background tab.",
        ),
      );
    }, timeoutMs);

    document.addEventListener("visibilitychange", onChange);
    signal?.addEventListener("abort", onAbort);
  });
}
