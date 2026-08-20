/**
 * Host-side controller for the sandbox iframe.
 *
 * Responsibilities beyond "send a message":
 *
 * - Build the sandboxed document with a CSP strict enough that pasted code
 *   cannot phone home even if it wants to.
 * - Authenticate inbound messages. The sandbox has an opaque origin, so
 *   `event.origin` is the string "null" and is worth nothing as a check. We
 *   compare `event.source` against the live contentWindow instead.
 * - Survive hostile input. A `while (true)` in pasted code wedges the sandbox's
 *   main thread forever; no timeout inside the frame can fire, because the frame
 *   is the thing that is stuck. The only recovery is destroying the iframe, so
 *   the watchdog does exactly that and transparently rebuilds.
 */

import {
  PROTOCOL_VERSION,
  isInboundMessage,
  isResponse,
  type CommandEnvelope,
  type CommandType,
  type InstallRuntimeMessage,
  type ResultMap,
  type SandboxCommand,
  type SandboxError,
  type SandboxEvent,
} from "@/sandbox/protocol";

const DEFAULT_TIMEOUT_MS = 5_000;

/** Runtime source URL. Fetched once per page, cached by the browser after that. */
const RUNTIME_URL = "/sandbox/runtime.js";

let runtimeSourcePromise: Promise<string> | null = null;

function loadRuntimeSource(): Promise<string> {
  if (!runtimeSourcePromise) {
    runtimeSourcePromise = fetch(RUNTIME_URL)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load sandbox runtime: HTTP ${res.status}`);
        }
        return res.text();
      })
      .catch((err: unknown) => {
        // Do not memoise a failure — a transient network blip should not
        // permanently break every future sandbox.
        runtimeSourcePromise = null;
        throw err;
      });
  }
  return runtimeSourcePromise;
}

const TIMEOUTS: Partial<Record<CommandType, number>> = {
  mount: 10_000,
  drive: 15_000,
  run_axe: 20_000,
  trace_focus_order: 15_000,
  ping: 2_000,
};

export class SandboxHangError extends Error {
  constructor(public readonly command: CommandType, public readonly timeoutMs: number) {
    super(
      `Sandbox stopped responding during "${command}" after ${timeoutMs}ms. ` +
        `The component most likely blocked the main thread. The sandbox was restarted.`,
    );
    this.name = "SandboxHangError";
  }
}

export class SandboxCommandError extends Error {
  constructor(message: string, public readonly detail: SandboxError) {
    super(message);
    this.name = "SandboxCommandError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  command: CommandType;
}

export type SandboxEventListener = (event: SandboxEvent) => void;

export interface SandboxControllerOptions {
  /** Where to attach the iframe. Defaults to a hidden container on <body>. */
  parent?: HTMLElement;
  /** Called whenever the sandbox is rebuilt after a hang or a crash. */
  onRestart?: (reason: string) => void;
}

export class SandboxController {
  private iframe: HTMLIFrameElement | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<SandboxEventListener>();
  private seq = 0;
  private destroyed = false;

  constructor(private readonly options: SandboxControllerOptions = {}) {
    window.addEventListener("message", this.handleMessage);
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  async send<K extends CommandType>(
    command: Extract<SandboxCommand, { type: K }>,
    timeoutMs?: number,
  ): Promise<ResultMap[K]> {
    if (this.destroyed) throw new Error("Sandbox controller has been destroyed.");

    await this.ensureReady();

    const id = `c${(this.seq += 1)}`;
    const budget = timeoutMs ?? TIMEOUTS[command.type] ?? DEFAULT_TIMEOUT_MS;

    const envelope: CommandEnvelope = {
      channel: "curb",
      version: PROTOCOL_VERSION,
      id,
      command,
    };

    return new Promise<ResultMap[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The frame is wedged; nothing inside it will ever answer.
        this.restart(`hang during "${command.type}"`);
        reject(new SandboxHangError(command.type, budget));
      }, budget);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        command: command.type,
      });

      this.iframe?.contentWindow?.postMessage(envelope, "*");
    });
  }

  onEvent(listener: SandboxEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop the current frame and build a clean one. */
  restart(reason: string): void {
    this.teardownFrame(new Error(`Sandbox restarted: ${reason}`));
    this.options.onRestart?.(reason);
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener("message", this.handleMessage);
    this.teardownFrame(new Error("Sandbox destroyed."));
    this.listeners.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  private ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.build();
    return this.ready;
  }

  private async build(): Promise<void> {
    // Fetched from the parent, where ordinary same-origin caching applies. The
    // sandbox itself never touches the network.
    const runtimeCode = await loadRuntimeSource();

    const iframe = document.createElement("iframe");

    // No allow-same-origin: this is the whole security model. Adding it would
    // hand pasted code access to our DOM, storage and cookies.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("title", "Component sandbox");
    iframe.style.cssText =
      "width:100%;height:100%;border:0;display:block;background:transparent";
    iframe.srcdoc = buildSandboxDocument();

    const parent = this.options.parent ?? hiddenContainer();
    parent.appendChild(iframe);
    this.iframe = iframe;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Sandbox failed to boot within 15s."));
      }, 15_000);

      const onEvent = (event: SandboxEvent) => {
        if (event.type === "boot-ready") {
          // Bootstrap is listening; hand it the runtime.
          iframe.contentWindow?.postMessage(
            {
              channel: "curb",
              version: PROTOCOL_VERSION,
              type: "install-runtime",
              code: runtimeCode,
            } satisfies InstallRuntimeMessage,
            "*",
          );
          return;
        }

        if (event.type === "ready") {
          cleanup();
          resolve();
          return;
        }

        if (event.type === "runtime-error") {
          cleanup();
          reject(new Error(event.error.message));
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(onEvent);
      };

      this.listeners.add(onEvent);
    });
  }

  private teardownFrame(reason: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }

    this.iframe?.remove();
    this.iframe = null;
    this.ready = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Messages                                                               */
  /* ---------------------------------------------------------------------- */

  private handleMessage = (event: MessageEvent): void => {
    // The sandbox's origin is opaque ("null"), so origin checks are useless.
    // Identity comes from the source window instead.
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    if (!isInboundMessage(event.data)) return;

    const message = event.data;

    if (!isResponse(message)) {
      for (const listener of this.listeners) listener(message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new SandboxCommandError(message.error.message, message.error),
      );
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Sandbox document                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The sandbox document loads no subresources at all.
 *
 * A sandboxed frame without `allow-same-origin` has an opaque origin, and an
 * opaque-origin document cannot reliably fetch http subresources from us — not
 * the runtime script, and in some environments not even its own document when
 * loaded via `src`. Inline scripts inside a sandboxed `srcdoc` do run, so the
 * runtime arrives over `postMessage` instead and is evaluated by this
 * bootstrap.
 *
 * Two things fall out of that, both good:
 *   - The parent fetches `runtime.js` once over ordinary same-origin HTTP, so
 *     normal caching still applies across every sandbox rebuild.
 *   - The CSP no longer has to whitelist our origin for scripts at all.
 *
 * `unsafe-eval` is unavoidable: compiled components are instantiated with
 * `new Function`, and the runtime itself now arrives as a string.
 * `connect-src 'none'` plus the narrow `img-src` are what make that acceptable
 * — code can run, but it has nowhere to send anything.
 */
export function buildSandboxDocument(): string {
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body{margin:0;padding:0;font:16px/1.5 system-ui,sans-serif;color:#111;background:#fff}
  #curb-root{padding:16px}
  @media (prefers-color-scheme: dark){html,body{color:#eee;background:#111}}
</style>
</head>
<body>
<div id="curb-root"></div>
<script>
(function () {
  function send(msg) { parent.postMessage(msg, '*'); }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== 'curb' || data.type !== 'install-runtime') return;
    try {
      (0, eval)(data.code);
    } catch (err) {
      send({
        channel: 'curb',
        version: ${PROTOCOL_VERSION},
        type: 'runtime-error',
        error: { message: 'Runtime failed to evaluate: ' + (err && err.message), stack: err && err.stack }
      });
    }
  });

  send({ channel: 'curb', version: ${PROTOCOL_VERSION}, type: 'boot-ready' });
})();
</script>
</body>
</html>`;
}

function hiddenContainer(): HTMLElement {
  const existing = document.getElementById("curb-sandbox-host");
  if (existing) return existing as HTMLElement;

  const el = document.createElement("div");
  el.id = "curb-sandbox-host";
  el.style.cssText =
    "position:absolute;width:1200px;height:800px;left:-99999px;top:0;pointer-events:none";
  document.body.appendChild(el);
  return el;
}
